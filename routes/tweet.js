// Scheduling.js
const express = require("express");
const router = express.Router();
const { TwitterApi } = require("twitter-api-v2");
const supabase = require("../supabaseClient");
const { GoogleGenAI } = require("@google/genai");

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

// ---- Fetch latest AI news ----
async function getLatestAINews() {
  return "OpenAI releases GPT-5 with real-time multimodal capabilities!";
}

// ---- Generate AI tweet ----
async function generateTweet(newsText) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `Write a concise, engaging Twitter post about this news: ${newsText}. Keep it under 280 characters.`,
    });
    return response.text.slice(0, 280);
  } catch (err) {
    console.error("❌ AI generation failed:", err.message);
    return null;
  }
}

// ---- Process queue ----
async function processQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift();
  try {
    console.log("⏰ Fetching news for scheduled AI tweet...");
    const news = await getLatestAINews();
    const tweetText = await generateTweet(news);

    if (!tweetText) throw new Error("AI failed to generate tweet");

    await client.v2.tweet(tweetText);

    await supabase
      .from("scheduled_tweets")
      .update({ status: "sent", text: tweetText })
      .eq("id", job.id);

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
router.post("/post", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).send("Text required");
    await client.v2.tweet(text);
    res.render("success", { message: "✅ Tweet posted!" });
  } catch (err) {
    res.render("error", { message: `❌ ${err.message}` });
  }
});

router.post("/schedule", async (req, res) => {
  try {
    const { text, scheduleType } = req.body;
    if (!text || !scheduleType) return res.status(400).send("Text & scheduleType required");

    let cronTime = scheduleType === "everyMinute" ? "*/1 * * * *" : null;
    if (!cronTime) return res.status(400).send("Unsupported schedule type");

    const { data, error } = await supabase
      .from("scheduled_tweets")
      .insert([{ text, schedule_type: scheduleType, cron_time: cronTime, status: "scheduled" }])
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
