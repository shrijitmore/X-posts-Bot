const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Import services and utilities
const twitterService = require('../services/TwitterService');
const aiService = require('../services/AIService');
const databaseService = require('../services/DatabaseService');
const queueService = require('../services/QueueService');
const { validate, schemas } = require('../utils/validation');
const logger = require('../utils/logger');
const config = require('../config');

// Configure multer for file uploads
const upload = multer({
  dest: config.uploads.uploadDir,
  limits: {
    fileSize: config.uploads.maxFileSize,
  },
  fileFilter: (req, file, cb) => {
    if (config.uploads.allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  },
});

// ---- Rate Limit Status ----
router.get('/rate-status', async (req, res) => {
  try {
    const status = await twitterService.getRateLimitStatus();
    res.json(status);
  } catch (error) {
    logger.error('Rate limit check failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

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
    const prompt = job.custom_prompt || job.text || "Share an interesting tech insight";
    const tweetResult = await generateTweet(prompt, job.include_image);

    if (!tweetResult || !tweetResult.text) throw new Error("AI failed to generate tweet");
    const tweetText = tweetResult.text;

    let mediaId = null;
    if (job.include_image) {
      console.log("🖼️ Processing image for tweet...");
      const imageUrl = job.image_url || await generateImage(job.image_prompt || prompt);
      if (imageUrl) {
        const imagePath = path.join(__dirname, '../uploads', `image-${Date.now()}.jpg`);
        await downloadImage(imageUrl, imagePath);
        console.log("📤 Uploading image to Twitter...");
        const mediaUpload = await client.v1.uploadMedia(imagePath);
        mediaId = mediaUpload;
        fs.unlinkSync(imagePath);
      }
    }

    // Try to post tweet with retry logic for rate limiting
    const postResult = await postTweetWithRetry(tweetText, job, mediaId);

    if (postResult === "RATE_LIMIT_REACHED") {
      // Reschedule the job for the next interval
      console.log("🔄 Rate limit reached, rescheduling tweet...");
      setTimeout(() => {
        jobQueue.push(job);
        processQueue();
      }, getIntervalMs(job.cron_time) || 60 * 1000); // fallback to 1 min
      return;
    }

    // Save tweet history to database for persistence
    try {
      const historyData = {
        text: tweetText,
        created_at: new Date().toISOString()
      };
      if (mediaId) {
        historyData.has_image = true;
        historyData.image_prompt = job.image_prompt || prompt;
      }
      await supabase.from("tweet_history").insert([historyData]).select();
    } catch (err) {
      console.warn("⚠️ Failed to save tweet to history:", err.message);
    }

    console.log("✅ AI Tweet posted:", tweetText);
  } catch (err) {
    console.error("❌ Tweet failed:", err.message);
    await supabase.from("scheduled_tweets").update({ status: "failed" }).eq("id", job.id);
  } finally {
    isProcessing = false;
    setTimeout(processQueue, 1000);
  }
}

// ---- Post tweet with retry logic for rate limiting ----
async function postTweetWithRetry(tweetText, job, mediaId = null, retryCount = 0) {
  try {
    const rateStatus = await updateRateLimitStatus();
    if (rateStatus && rateStatus.daily.remaining <= 0) {
      return "RATE_LIMIT_REACHED";
    }

    const tweetOptions = {};
    if (mediaId) {
      tweetOptions.media = { media_ids: [mediaId] };
    }
    await client.v2.tweet(tweetText, tweetOptions);

    await supabase
      .from("scheduled_tweets")
      .update({ status: "sent", text: tweetText })
      .eq("id", job.id);

    return true;
  } catch (error) {
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

// Track rate limit status
let rateLimitStatus = {
  daily: {
    limit: 17,
    remaining: 17,
    reset: 0
  },
  lastUpdated: 0
};

// Update rate limit status
async function updateRateLimitStatus() {
  try {
    const rateLimits = await client.v2.tweet('dummy', { dry_run: true })
      .catch(error => error.rateLimit || null);
      
    if (rateLimits?.day) {
      rateLimitStatus = {
        daily: {
          limit: rateLimits.day.limit,
          remaining: rateLimits.day.remaining,
          reset: rateLimits.day.reset * 1000 // Convert to milliseconds
        },
        lastUpdated: Date.now()
      };
    }
    return rateLimitStatus;
  } catch (error) {
    console.error("Failed to update rate limit status:", error);
    return null;
  }
}

// ---- Get Rate Limits ----
router.get("/rate-status", async (req, res) => {
  try {
    const status = await updateRateLimitStatus();
    if (!status) {
      return res.status(500).json({
        success: false,
        error: "Failed to get rate limit status"
      });
    }

    const now = Date.now();
    const resetTime = new Date(status.daily.reset);
    const timeUntilReset = Math.max(0, status.daily.reset - now);
    
    res.json({
      success: true,
      limit: status.daily.limit,
      remaining: status.daily.remaining,
      reset: status.daily.reset,
      resetTime: resetTime.toISOString(),
      timeUntilReset: timeUntilReset,
      status: status.daily.remaining > 0 ? "OK" : "RATE_LIMIT_REACHED",
      message: status.daily.remaining > 0 
        ? `You have ${status.daily.remaining} tweets remaining today.`
        : `Daily limit reached. Resets in ${Math.ceil(timeUntilReset / (1000 * 60 * 60))} hours.`
    });
  } catch (error) {
    console.error("Rate limit check failed:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ---- API Endpoints ----
router.post("/post", upload.single('image'), async (req, res) => {
  try {
    const { text, imagePrompt } = req.body;
    if (!text) return res.status(400).send("Text required");
    
    // Check rate limits before attempting to post
    const rateStatus = await updateRateLimitStatus();
    if (rateStatus && rateStatus.daily.remaining <= 0) {
      const resetTime = new Date(rateStatus.daily.reset);
      const hoursUntilReset = Math.ceil((rateStatus.daily.reset - Date.now()) / (1000 * 60 * 60));
      
      return res.status(429).json({
        success: false,
        error: "RATE_LIMIT_REACHED",
        message: `Daily tweet limit reached. You've used all ${rateStatus.daily.limit} tweets.`,
        resetTime: resetTime.toISOString(),
        timeUntilReset: `${hoursUntilReset} hours`,
        limit: rateStatus.daily.limit,
        remaining: 0
      });
    }
    
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
    const { text, scheduleType, customPrompt, imagePrompt, includeImage, customCron, time } = req.body;
    if (!scheduleType) return res.status(400).send("scheduleType required");

    let cronTime;
    if (scheduleType === "everyMinute") {
      cronTime = "*/1 * * * *";
    } else if (scheduleType === "hourly") {
      cronTime = "0 * * * *";
    } else if (scheduleType === "daily") {
      // If time is provided, use it, otherwise default to midnight
      const [hour, minute] = (time || "00:00").split(":");
      cronTime = `${minute} ${hour} * * *`;
    } else if (scheduleType === "weekly") {
      // Default to Sunday at midnight, or use provided time
      const [hour, minute] = (time || "00:00").split(":");
      cronTime = `${minute} ${hour} * * 0`;
    } else if (scheduleType === "custom" && customCron) {
      cronTime = customCron;
    } else {
      return res.status(400).send("Unsupported schedule type");
    }

    // Process image if provided
    let imageUrl = null;
    if (req.file) {
      imageUrl = "https://picsum.photos/800/600";
      fs.unlinkSync(req.file.path);
    }

    const scheduleData = {
      schedule_type: scheduleType,
      cron_time: cronTime,
      status: "scheduled",
      custom_prompt: customPrompt || null,
      include_image: includeImage === 'true' || includeImage === true,
      image_url: imageUrl,
      image_prompt: imagePrompt || null
    };
    if (text) {
      scheduleData.text = text;
    }

    // Remove rate limit check here!

    const { data, error } = await supabase
      .from("scheduled_tweets")
      .insert([scheduleData])
      .select();

    if (error) {
      console.error(" Database error:", error);
      return res.status(500).send("Failed to schedule tweet");
    }

    scheduleTweetJob(data[0]);
    res.render("success", { message: " Tweet scheduled!" });
  } catch (err) {
    res.render("error", { message: ` ${err.message}` });
  }
});

router.get("/scheduled", async (req, res) => {
  const { data, error } = await supabase.from("scheduled_tweets").select("*");
  if (error) return res.render("error", { message: ` ${error.message}` });
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
