require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

const app = express();

// 🔑 Use your own Supabase project URL + API key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Set EJS
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Routes
const tweetRoutes = require("./routes/tweet");
app.use("/tweet", tweetRoutes);



// Home page (form)
app.get("/", async (req, res) => {
    try {
      const { data: tweets, error } = await supabase
        .from("scheduled_tweets")
        .select("*")
        .order("created_at", { ascending: false });
  
      if (error) {
        console.error("❌ Supabase fetch error:", error.message);
        return res.render("index", { tweets: [] });
      }
  
      res.render("index", { tweets });
    } catch (err) {
      console.error("❌ Error loading index:", err.message);
      res.render("index", { tweets: [] });
    }
  });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
