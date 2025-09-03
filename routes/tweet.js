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

// ---- AI Tweet Generation (One-time) ----
router.post('/ai-generate', async (req, res) => {
  try {
    const validatedData = validate(schemas.aiGenerate, req.body);
    const { prompt, includeImage, imagePrompt } = validatedData;

    // Generate AI tweet
    const aiResult = await aiService.generateTweet(prompt, {
      includeImage,
      tone: req.body.tone || 'engaging',
    });

    res.json({
      success: true,
      data: {
        text: aiResult.text,
        includeImage: aiResult.includeImage,
        generatedAt: aiResult.generatedAt,
        prompt,
      },
    });

  } catch (error) {
    logger.error('AI tweet generation failed:', error.message);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// ---- AI Multiple Tweet Suggestions ----
router.post('/ai-suggestions', async (req, res) => {
  try {
    const { prompt, count = 3, tone = 'engaging' } = req.body;
    
    if (!prompt || prompt.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'Prompt must be at least 10 characters long',
      });
    }

    const suggestions = await aiService.generateMultipleTweets(prompt, count, {
      tone,
      variety: true,
    });

    res.json({
      success: true,
      data: suggestions,
    });

  } catch (error) {
    logger.error('AI suggestions generation failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---- Post Tweet Immediately ----
router.post('/post', upload.single('image'), async (req, res) => {
  try {
    const validatedData = validate(schemas.tweet, req.body);
    const { text, imagePrompt } = validatedData;

    // Check rate limits
    const rateLimitStatus = await twitterService.getRateLimitStatus();
    if (rateLimitStatus.status !== 'OK') {
      return res.status(429).render('error', {
        message: `❌ ${rateLimitStatus.message}`,
      });
    }

    // Prepare tweet data
    const tweetData = {
      text,
      imagePrompt,
      imageFile: req.file ? req.file.path : null,
    };

    // Add to immediate tweet queue
    await queueService.addTweetJob({ tweetData });

    res.render('success', { 
      message: '✅ Tweet queued for posting!',
    });

  } catch (error) {
    logger.error('Tweet posting failed:', error.message);
    
    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.render('error', { 
      message: `❌ ${error.message}`,
    });
  }
});

// ---- Schedule Tweet ----
router.post('/schedule', upload.single('image'), async (req, res) => {
  try {
    const validatedData = validate(schemas.schedule, req.body);
    const { 
      text, 
      scheduleType, 
      customPrompt, 
      imagePrompt, 
      includeImage, 
      customCron, 
      time 
    } = validatedData;

    // Convert schedule type to cron expression
    let cronTime;
    switch (scheduleType) {
      case 'everyMinute':
        cronTime = '*/1 * * * *';
        break;
      case 'hourly':
        cronTime = '0 * * * *';
        break;
      case 'daily':
        const [hour, minute] = (time || '00:00').split(':');
        cronTime = `${minute} ${hour} * * *`;
        break;
      case 'weekly':
        const [wHour, wMinute] = (time || '00:00').split(':');
        cronTime = `${wMinute} ${wHour} * * 0`; // Sunday
        break;
      case 'custom':
        cronTime = customCron;
        break;
      default:
        throw new Error('Invalid schedule type');
    }

    // Process image if uploaded
    let imageUrl = null;
    if (req.file) {
      // For now, we'll use a placeholder URL and clean up the file
      imageUrl = 'https://picsum.photos/800/600';
      fs.unlinkSync(req.file.path);
    }

    // Create scheduled tweet record
    const scheduleData = {
      schedule_type: scheduleType,
      cron_time: cronTime,
      status: 'scheduled',
      custom_prompt: customPrompt || null,
      include_image: includeImage === 'true' || includeImage === true,
      image_url: imageUrl,
      image_prompt: imagePrompt || null,
      text: text || null,
    };

    const scheduledTweet = await databaseService.createScheduledTweet(scheduleData);

    // Add to scheduled tweet queue
    await queueService.addScheduledTweetJob({
      ...scheduleData,
      id: scheduledTweet.id,
    }, cronTime);

    logger.info('Tweet scheduled successfully:', scheduledTweet.id);
    res.render('success', { 
      message: '✅ Tweet scheduled successfully!',
    });

  } catch (error) {
    logger.error('Tweet scheduling failed:', error.message);
    
    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.render('error', { 
      message: `❌ ${error.message}`,
    });
  }
});

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
