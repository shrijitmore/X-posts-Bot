require('dotenv').config();

const config = {
  port: process.env.PORT || 8080,
  
  // Redis Configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || null,
  },
  
  // Supabase Configuration
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  
  // Twitter API Configuration
  twitter: {
    apiKey: process.env.TWITTER_API_KEY,
    apiSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  },
  
  // AI Configuration
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY,
  },
  
  // Rate Limiting Configuration
  rateLimits: {
    dailyTweetLimit: 17, // Twitter free tier limit
    apiRequestsPerMinute: 60,
    schedulingDistributionHours: 24,
  },
  
  // File Upload Configuration
  uploads: {
    maxFileSize: 5 * 1024 * 1024, // 5MB
    allowedMimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    uploadDir: 'uploads/',
  },
  
  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'app.log',
  },
};

module.exports = config;