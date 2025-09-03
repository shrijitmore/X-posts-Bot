const Joi = require('joi');

const schemas = {
  tweet: Joi.object({
    text: Joi.string().min(1).max(280).required(),
    imagePrompt: Joi.string().max(500).optional(),
  }),

  schedule: Joi.object({
    text: Joi.string().max(280).optional(),
    scheduleType: Joi.string().valid('everyMinute', 'hourly', 'daily', 'weekly', 'custom').required(),
    customPrompt: Joi.string().max(500).optional(),
    imagePrompt: Joi.string().max(500).optional(),
    includeImage: Joi.boolean().optional(),
    customCron: Joi.string().optional(),
    time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  }),

  aiGenerate: Joi.object({
    prompt: Joi.string().min(10).max(500).required(),
    includeImage: Joi.boolean().optional(),
    imagePrompt: Joi.string().max(500).optional(),
  }),
};

const validate = (schema, data) => {
  const { error, value } = schema.validate(data);
  if (error) {
    throw new Error(`Validation error: ${error.details[0].message}`);
  }
  return value;
};

module.exports = {
  schemas,
  validate,
};