// Scheduling.js
const express = require("express");
const router = express.Router();
const { TwitterApi } = require("twitter-api-v2");
const supabase = require("../supabaseClient");
const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

// Gemini AI client
const ai = new GoogleGenAI({});

// Twitter client
const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// Queue system to handle jobs sequentially
let jobQueue = [];
let isProcessing = false;

// Store previous tweets to avoid repetition
const previousTweets = [];
const MAX_HISTORY = 10;

// ---- Generate AI tweet from any prompt ----
async function generateTweet(prompt, includeImage = false) {
  try {
    // Get previous tweets to provide as context
    const previousTweetsContext = previousTweets.length > 0 
      ? `Previous tweets (DO NOT repeat these): ${previousTweets.join(" | ")}` 
      : "";
    
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `Write a concise, engaging Twitter post about: ${prompt}. 
      Be informative, creative and original. Keep it under 280 characters.
      ${previousTweetsContext}`,
    });
    
    const tweetText = response.text.slice(0, 280);
    
    // Store this tweet in history to avoid repetition
    previousTweets.unshift(tweetText);
    if (previousTweets.length > MAX_HISTORY) {
      previousTweets.pop();
    }
    
    return { text: tweetText, includeImage };
  } catch (err) {
    console.error("❌ AI generation failed:", err.message);
    return null;
  }
}

// ---- Generate image based on prompt ----
async function generateImage(prompt) {
  try {
    // For now, we'll use a placeholder image URL
    // In a real implementation, you would integrate with an image generation API
    // like DALL-E, Midjourney, or Stable Diffusion
    return "https://picsum.photos/800/600";
  } catch (err) {
    console.error("❌ Image generation failed:", err.message);
    return null;
  }
}

// ---- Download image from URL ----
async function downloadImage(url, filepath) {
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });
    
    // Ensure directory exists
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Save the file
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (err) {
    console.error("❌ Failed to download image:", err.message);
    throw err;
  }
}

// ---- Process queue ----
async function processQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift();
  try {
    console.log("⏰ Generating tweet content...");
    
    // Use custom prompt if provided, otherwise use the text field
    const prompt = job.custom_prompt || job.text || "Share an interesting tech insight";
    const tweetResult = await generateTweet(prompt, job.include_image);

    if (!tweetResult || !tweetResult.text) throw new Error("AI failed to generate tweet");
    const tweetText = tweetResult.text;

    // Check if we need to include an image
    let mediaId = null;
    if (job.include_image) {
      console.log("🖼️ Processing image for tweet...");
      
      // Get image URL (from job or generate one)
      const imageUrl = job.image_url || await generateImage(job.image_prompt || prompt);
      
      if (imageUrl) {
        // Download the image
        const imagePath = path.join(__dirname, '../uploads', `image-${Date.now()}.jpg`);
        await downloadImage(imageUrl, imagePath);
        
        // Upload to Twitter
        console.log("📤 Uploading image to Twitter...");
        const mediaUpload = await client.v1.uploadMedia(imagePath);
        mediaId = mediaUpload;
        
        // Clean up the file
        fs.unlinkSync(imagePath);
      }
    }

    // Try to post tweet with retry logic for rate limiting
    await postTweetWithRetry(tweetText, job, mediaId);
    
    // Save tweet history to database for persistence
    try {
      const historyData = {
        text: tweetText,
        created_at: new Date().toISOString()
      };
      
      // Include image information if available
      if (mediaId) {
        historyData.has_image = true;
        historyData.image_prompt = job.image_prompt || prompt;
      }
      
      await supabase
        .from("tweet_history")
        .insert([historyData])
        .select();
    } catch (err) {
      // Non-critical error, just log it
      console.warn("⚠️ Failed to save tweet to history:", err.message);
    }

    console.log("✅ AI Tweet posted:", tweetText);
  } catch (err) {
    console.error("❌ Tweet failed:", err.message);
    await supabase
      .from("scheduled_tweets")
      .update({ status: "failed" })
      .eq("id", job.id);
  } finally {
    isProcessing = false;
    setTimeout(processQueue, 1000); // check queue again
  }
}

// ---- Post tweet with retry logic for rate limiting ----
async function postTweetWithRetry(tweetText, job, mediaId = null, retryCount = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 60000; // 1 minute delay between retries
  
  try {
    // Create tweet options
    const tweetOptions = {};
    
    // Add media if available
    if (mediaId) {
      tweetOptions.media = { media_ids: [mediaId] };
    }
    
    // Post the tweet
    await client.v2.tweet(tweetText, tweetOptions);
    
    // Update status in database on success
    await supabase
      .from("scheduled_tweets")
      .update({ status: "sent", text: tweetText })
      .eq("id", job.id);
      
    return true;
  } catch (error) {
    // Handle rate limiting (429 error)
    if (error.code === 429 && retryCount < MAX_RETRIES) {
      console.log(`⚠️ Rate limited by Twitter API. Retrying in ${RETRY_DELAY/1000} seconds... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
      
      // Wait for the retry delay
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      
      // Recursive retry
      return postTweetWithRetry(tweetText, job, mediaId, retryCount + 1);
    }
    
    // If we've exhausted retries or it's another error, rethrow
    throw error;
  }
}

// ---- Add job to queue ----
function enqueueTweetJob(tweet) {
  jobQueue.push(tweet);
  processQueue();
}

// ---- Schedule jobs based on cron intervals ----
function scheduleTweetJob(tweet) {
  const intervalMs = getIntervalMs(tweet.cron_time);
  if (!intervalMs) return;

  setInterval(() => {
    enqueueTweetJob(tweet);
  }, intervalMs);
}

// ---- Convert simple cron-like string to ms ----
function getIntervalMs(cronTime) {
  if (cronTime === "*/1 * * * *") return 60 * 1000;
  if (cronTime === "0 * * * *") return 60 * 60 * 1000;
  // Add more conversions if needed
  return null;
}

// ---- Load scheduled tweets from Supabase ----
async function loadScheduledTweets() {
  const { data, error } = await supabase
    .from("scheduled_tweets")
    .select("*")
    .eq("status", "scheduled");

  if (error) return console.error("❌ Failed to load scheduled tweets:", error.message);

  data.forEach((tweet) => scheduleTweetJob(tweet));
}

loadScheduledTweets();

// ---- API Endpoints ----
router.post("/post", upload.single('image'), async (req, res) => {
  try {
    const { text, imagePrompt } = req.body;
    if (!text) return res.status(400).send("Text required");
    
    // Handle image if provided
    let mediaId = null;
    if (req.file) {
      console.log("📤 Uploading provided image to Twitter...");
      mediaId = await client.v1.uploadMedia(req.file.path);
      
      // Clean up the file
      fs.unlinkSync(req.file.path);
    } else if (imagePrompt) {
      console.log("🖼️ Generating image from prompt...");
      const imageUrl = await generateImage(imagePrompt);
      
      if (imageUrl) {
        // Download the image
        const imagePath = path.join(__dirname, '../uploads', `image-${Date.now()}.jpg`);
        await downloadImage(imageUrl, imagePath);
        
        // Upload to Twitter
        console.log("📤 Uploading generated image to Twitter...");
        mediaId = await client.v1.uploadMedia(imagePath);
        
        // Clean up the file
        fs.unlinkSync(imagePath);
      }
    }
    
    // Create tweet options
    const tweetOptions = {};
    
    // Add media if available
    if (mediaId) {
      tweetOptions.media = { media_ids: [mediaId] };
    }
    
    // Post the tweet
    await client.v2.tweet(text, tweetOptions);
    
    res.render("success", { message: "✅ Tweet posted!" });
  } catch (err) {
    res.render("error", { message: `❌ ${err.message}` });
  }
});

router.post("/schedule", upload.single('image'), async (req, res) => {
  try {
    const { text, scheduleType, customPrompt, imagePrompt, includeImage } = req.body;
    if (!scheduleType) return res.status(400).send("scheduleType required");

    let cronTime = scheduleType === "everyMinute" ? "*/1 * * * *" : 
                  scheduleType === "hourly" ? "0 * * * *" : null;
    if (!cronTime) return res.status(400).send("Unsupported schedule type");

    // Process image if provided
    let imageUrl = null;
    if (req.file) {
      // Save the image to Supabase storage or another storage service
      // For now, we'll just use a placeholder URL
      imageUrl = "https://picsum.photos/800/600";
      
      // Clean up the file
      fs.unlinkSync(req.file.path);
    }

    // Allow scheduling with either predefined text or AI-generated content
    const scheduleData = {
      schedule_type: scheduleType,
      cron_time: cronTime,
      status: "scheduled",
      custom_prompt: customPrompt || null,
      include_image: includeImage === 'true' || includeImage === true,
      image_url: imageUrl,
      image_prompt: imagePrompt || null
    };
    
    // If text is provided, use it directly instead of AI generation
    if (text) {
      scheduleData.text = text;
    }

    const { data, error } = await supabase
      .from("scheduled_tweets")
      .insert([scheduleData])
      .select();

    if (error) throw error;

    scheduleTweetJob(data[0]);
    res.render("success", { message: "✅ Tweet scheduled!" });
  } catch (err) {
    res.render("error", { message: `❌ ${err.message}` });
  }
});

router.get("/scheduled", async (req, res) => {
  const { data, error } = await supabase.from("scheduled_tweets").select("*");
  if (error) return res.render("error", { message: `❌ ${error.message}` });
  res.render("scheduled", { tweets: data });
});

router.post("/cancel/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await supabase.from("scheduled_tweets").update({ status: "cancelled" }).eq("id", id);
    res.render("success", { message: "❌ Tweet cancelled" });
  } catch (err) {
    res.render("error", { message: `❌ ${err.message}` });
  }
});

module.exports = router;
