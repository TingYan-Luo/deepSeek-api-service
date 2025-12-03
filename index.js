require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs').promises;
const path = require('path');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const winston = require('winston');
const axios = require('axios');

// 创建Express应用
const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

// ==================== 配置验证 ====================
const requiredEnvVars = ['DS_API_KEY', 'DEEPSEEK_API_URL'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ 错误：缺少必要的环境变量 ${envVar}`);
    process.exit(1);
  }
}

console.log('✅ 环境变量验证通过');

// ==================== 日志配置 ====================
const logDir = path.join(__dirname, 'logs');
const dataDir = path.join(__dirname, 'data');

// 确保目录存在
(async () => {
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
  } catch (err) {
    console.error('创建目录失败:', err);
  }
})();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

if (process.env.LOG_TO_FILE === 'true') {
  logger.add(new winston.transports.File({ 
    filename: path.join(logDir, 'api.log'),
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }));
}

// ==================== 用量监控系统 ====================
class UsageTracker {
  constructor() {
    this.usageFile = path.join(dataDir, 'usage.json');
    this.usageData = {
      monthlyTokens: 0,
      dailyTokens: {},
      totalRequests: 0,
      monthlyResetDate: new Date().getDate(),
      costs: 0
    };
    this.loadUsageData();
  }

  async loadUsageData() {
    try {
      const data = await fs.readFile(this.usageFile, 'utf8');
      this.usageData = JSON.parse(data);
      
      // 检查是否需要重置月度用量（每月1号重置）
      const today = new Date();
      if (today.getDate() === 1 && today.getDate() !== this.usageData.monthlyResetDate) {
        logger.info('🔄 月度用量重置');
        this.usageData.monthlyTokens = 0;
        this.usageData.monthlyResetDate = today.getDate();
        this.saveUsageData();
      }
      
      logger.info(`📊 已加载用量数据: ${this.usageData.monthlyTokens} tokens`);
    } catch (error) {
      logger.warn('用量文件不存在，创建新的用量记录');
      await this.saveUsageData();
    }
  }

  async saveUsageData() {
    try {
      await fs.writeFile(this.usageFile, JSON.stringify(this.usageData, null, 2));
    } catch (error) {
      logger.error('保存用量数据失败:', error);
    }
  }

  async trackUsage(tokensUsed, model = 'deepseek-chat') {
    const today = new Date().toISOString().split('T')[0];
    
    // 更新月度用量
    this.usageData.monthlyTokens += tokensUsed;
    
    // 更新每日用量
    if (!this.usageData.dailyTokens[today]) {
      this.usageData.dailyTokens[today] = 0;
    }
    this.usageData.dailyTokens[today] += tokensUsed;
    
    // 更新总请求数
    this.usageData.totalRequests += 1;
    
    // 计算成本（假设价格）
    const pricePerMillion = this.getPricePerMillion(model);
    this.usageData.costs += (tokensUsed / 1000000) * pricePerMillion;
    
    await this.saveUsageData();
    
    logger.info(`📝 记录用量: ${tokensUsed} tokens | 月度总计: ${this.usageData.monthlyTokens} tokens`);
  }

  getPricePerMillion(model) {
    // DeepSeek价格参考（人民币/百万tokens）
    const prices = {
      'deepseek-chat': 1.5,
      'deepseek-coder': 2.0,
      'deepseek-reasoner': 4.0
    };
    return prices[model] || 1.5;
  }

  getRemainingTokens() {
    const monthlyLimit = parseInt(process.env.MONTHLY_TOKEN_LIMIT) || 1000000;
    const dailyLimit = parseInt(process.env.DAILY_TOKEN_LIMIT) || 50000;
    const today = new Date().toISOString().split('T')[0];
    const dailyUsed = this.usageData.dailyTokens[today] || 0;
    
    return {
      monthlyRemaining: Math.max(0, monthlyLimit - this.usageData.monthlyTokens),
      dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
      monthlyUsed: this.usageData.monthlyTokens,
      dailyUsed: dailyUsed,
      totalRequests: this.usageData.totalRequests,
      estimatedCost: this.usageData.costs.toFixed(4)
    };
  }

  async canMakeRequest(estimatedTokens = 1000) {
    const remaining = this.getRemainingTokens();
    const monthlyLimit = parseInt(process.env.MONTHLY_TOKEN_LIMIT) || 1000000;
    const dailyLimit = parseInt(process.env.DAILY_TOKEN_LIMIT) || 50000;
    
    if (remaining.monthlyRemaining < estimatedTokens) {
      logger.warn(`❌ 月度额度不足: ${remaining.monthlyRemaining} tokens 剩余，需要 ${estimatedTokens} tokens`);
      return {
        allowed: false,
        reason: 'MONTHLY_LIMIT_EXCEEDED',
        remaining: remaining.monthlyRemaining,
        required: estimatedTokens
      };
    }
    
    if (remaining.dailyRemaining < estimatedTokens) {
      logger.warn(`❌ 每日额度不足: ${remaining.dailyRemaining} tokens 剩余，需要 ${estimatedTokens} tokens`);
      return {
        allowed: false,
        reason: 'DAILY_LIMIT_EXCEEDED',
        remaining: remaining.dailyRemaining,
        required: estimatedTokens
      };
    }
    
    return {
      allowed: true,
      remaining: {
        monthly: remaining.monthlyRemaining,
        daily: remaining.dailyRemaining
      }
    };
  }
}

// 初始化用量跟踪器
const usageTracker = new UsageTracker();

// ==================== 速率限制 ====================
const rateLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_PER_MINUTE) || 60,
  duration: 60, // 60秒
});

const rateLimitMiddleware = async (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  
  try {
    await rateLimiter.consume(clientIP);
    next();
  } catch (error) {
    logger.warn(`速率限制: IP ${clientIP} 超过限制`);
    res.status(429).json({
      error: '请求过于频繁',
      message: '请稍后再试',
      retryAfter: Math.ceil(error.msBeforeNext / 1000)
    });
  }
};

// ==================== 中间件配置 ====================
// 安全头部
app.use(helmet({
  contentSecurityPolicy: false, // 可以根据需要配置
}));

// CORS配置
const corsOptions = {
  origin: process.env.CORS_ORIGIN ? 
    process.env.CORS_ORIGIN.split(',') : 
    ['http://localhost:19006', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400 // 24小时
};
app.use(cors(corsOptions));

// 请求日志
app.use(morgan('combined', { 
  stream: { write: message => logger.info(message.trim()) } 
}));

// 解析JSON请求体
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==================== 辅助函数 ====================
// 估算tokens数量（粗略估算，实际以DeepSeek返回为准）
function estimateTokens(text) {
  // 简单估算：中文1个token ≈ 0.5个汉字，英文1个token ≈ 0.75个单词
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (text.match(/\b[a-zA-Z]+\b/g) || []).length;
  const otherChars = text.length - chineseChars - englishWords;
  
  return Math.ceil(chineseChars * 0.5 + englishWords * 0.75 + otherChars * 0.25);
}

// 验证请求参数
function validateRequest(req) {
  const { model, messages, max_tokens } = req.body;
  
  const errors = [];
  
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    errors.push('messages字段必须是非空数组');
  }
  
  // 检查模型是否允许
  const allowedModels = (process.env.ALLOWED_MODELS || 'deepseek-chat').split(',');
  if (model && !allowedModels.includes(model)) {
    errors.push(`模型 ${model} 不在允许列表中`);
  }
  
  // 检查tokens限制
  const maxTokensPerRequest = parseInt(process.env.MAX_TOKENS_PER_REQUEST) || 2000;
  if (max_tokens && max_tokens > maxTokensPerRequest) {
    errors.push(`每次请求最大tokens不能超过 ${maxTokensPerRequest}`);
  }
  
  return errors;
}

// ==================== API路由 ====================

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'DeepSeek API Proxy',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    usage: usageTracker.getRemainingTokens()
  });
});

// 获取用量统计
app.get('/usage', rateLimitMiddleware, (req, res) => {
  res.json({
    success: true,
    data: usageTracker.getRemainingTokens(),
    timestamp: new Date().toISOString()
  });
});

// 重置用量（仅开发环境可用）
app.post('/usage/reset', rateLimitMiddleware, async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({
      error: '此功能仅限开发环境使用'
    });
  }
  
  usageTracker.usageData = {
    monthlyTokens: 0,
    dailyTokens: {},
    totalRequests: 0,
    monthlyResetDate: new Date().getDate(),
    costs: 0
  };
  
  await usageTracker.saveUsageData();
  
  res.json({
    success: true,
    message: '用量数据已重置',
    data: usageTracker.getRemainingTokens()
  });
});

// DeepSeek API代理 - 聊天补全
app.post('/v1/chat/completions', rateLimitMiddleware, async (req, res) => {
  try {
    // 1. 验证请求
    const validationErrors = validateRequest(req);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: '请求参数错误',
        details: validationErrors
      });
    }
    
    // 2. 提取请求数据
    const {
      model = process.env.DEFAULT_MODEL || 'deepseek-chat',
      messages,
      temperature = 0.7,
      max_tokens = 1000,
      stream = false,
      ...otherParams
    } = req.body;
    
    // 3. 估算tokens用量
    const estimatedTokens = estimateTokens(messages.map(m => m.content).join(' ')) + max_tokens;
    
    // 4. 检查用量限制
    if (process.env.ENABLE_USAGE_TRACKING === 'true') {
      const canProceed = await usageTracker.canMakeRequest(estimatedTokens);
      if (!canProceed.allowed) {
        return res.status(429).json({
          error: '额度限制',
          message: canProceed.reason === 'MONTHLY_LIMIT_EXCEEDED' ? 
            '月度额度已用完' : '每日额度已用完',
          remaining: canProceed.remaining,
          required: canProceed.required,
          usage: usageTracker.getRemainingTokens()
        });
      }
    }
    
    // 5. 准备DeepSeek API请求
    const requestPayload = {
      model,
      messages,
      temperature: Math.min(Math.max(temperature, 0.1), 2.0),
      max_tokens: Math.min(max_tokens, parseInt(process.env.MAX_TOKENS_PER_REQUEST) || 2000),
      stream,
      ...otherParams
    };
    
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.info(`📤 转发请求 ${requestId}: model=${model}, messages=${messages.length}, estimatedTokens=${estimatedTokens}`);
    
    // 6. 调用DeepSeek API
    const startTime = Date.now();
    const response = await axios({
      method: 'POST',
      url: `${process.env.DEEPSEEK_API_URL}/v1/chat/completions`,
      headers: {
        'Authorization': `Bearer ${process.env.DS_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Request-ID': requestId
      },
      data: requestPayload,
      timeout: 120000, // 120秒超时
      responseType: stream ? 'stream' : 'json'
    });
    
    const responseTime = Date.now() - startTime;
    
    // 7. 处理流式和非流式响应
    if (stream) {
      // 流式响应直接传递
      logger.info(`📥 流式响应 ${requestId}: ${responseTime}ms`);
      
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-ID': requestId
      });
      
      response.data.pipe(res);
      
      // 流式响应难以准确统计用量，使用估算值
      if (process.env.ENABLE_USAGE_TRACKING === 'true') {
        usageTracker.trackUsage(estimatedTokens, model);
      }
      
    } else {
      // 非流式响应
      logger.info(`📥 响应 ${requestId}: ${responseTime}ms, status=${response.status}`);
      
      // 8. 记录用量
      if (process.env.ENABLE_USAGE_TRACKING === 'true' && response.data.usage) {
        const tokensUsed = response.data.usage.total_tokens;
        await usageTracker.trackUsage(tokensUsed, model);
        
        // 添加用量信息到响应
        response.data.usage.proxy_tracking = {
          monthly_remaining: usageTracker.getRemainingTokens().monthlyRemaining,
          daily_remaining: usageTracker.getRemainingTokens().dailyRemaining,
          estimated_cost: usageTracker.getPricePerMillion(model) * (tokensUsed / 1000000)
        };
      }
      
      // 9. 返回响应
      res.json({
        ...response.data,
        _proxy: {
          request_id: requestId,
          response_time: responseTime,
          timestamp: new Date().toISOString()
        }
      });
    }
    
  } catch (error) {
    logger.error('API代理错误:', {
      error: error.message,
      stack: error.stack,
      url: req.url,
      method: req.method
    });
    
    // 处理不同类型的错误
    if (error.response) {
      // DeepSeek API返回的错误
      res.status(error.response.status).json({
        error: 'DeepSeek API错误',
        message: error.response.data?.error?.message || error.message,
        code: error.response.data?.error?.code,
        status: error.response.status
      });
    } else if (error.request) {
      // 网络错误
      res.status(503).json({
        error: '网络错误',
        message: '无法连接到DeepSeek API',
        details: error.message
      });
    } else if (error.code === 'ECONNABORTED') {
      // 超时错误
      res.status(504).json({
        error: '请求超时',
        message: 'DeepSeek API响应超时',
        timeout: 120000
      });
    } else {
      // 其他错误
      res.status(500).json({
        error: '服务器内部错误',
        message: error.message
      });
    }
  }
});

// 其他DeepSeek API端点（可根据需要扩展）
app.post('/v1/completions', rateLimitMiddleware, async (req, res) => {
  // 类似实现，用于文本补全
  res.status(501).json({
    error: '未实现',
    message: '此端点暂未实现'
  });
});

// 模型列表（缓存）
let cachedModels = null;
let lastCacheTime = 0;
const CACHE_DURATION = 3600000; // 1小时

app.get('/v1/models', rateLimitMiddleware, async (req, res) => {
  try {
    // 检查缓存
    const now = Date.now();
    if (cachedModels && (now - lastCacheTime) < CACHE_DURATION) {
      return res.json(cachedModels);
    }
    
    // 从DeepSeek获取模型列表
    const response = await axios({
      method: 'GET',
      url: `${process.env.DEEPSEEK_API_URL}/v1/models`,
      headers: {
        'Authorization': `Bearer ${process.env.DS_API_KEY}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    
    // 缓存结果
    cachedModels = response.data;
    lastCacheTime = now;
    
    res.json(cachedModels);
    
  } catch (error) {
    logger.error('获取模型列表失败:', error);
    
    // 返回默认模型列表作为备选
    res.json({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model', created: 1677610602 },
        { id: 'deepseek-coder', object: 'model', created: 1677610603 }
      ]
    });
  }
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    error: '未找到',
    message: `路径 ${req.path} 不存在`,
    available_endpoints: [
      'GET /health',
      'GET /usage',
      'POST /v1/chat/completions',
      'GET /v1/models'
    ]
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  logger.error('未处理的错误:', err);
  res.status(500).json({
    error: '内部服务器错误',
    message: process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误'
  });
});

// ==================== 启动服务器 ====================
async function startServer() {
  try {
    app.listen(port, host, () => {
      console.log(`
🚀 DeepSeek API代理服务器已启动!
📡 地址: http://${host}:${port}
📊 健康检查: http://${host}:${port}/health
📈 用量统计: http://${host}:${port}/usage
🔐 API端点: http://${host}:${port}/v1/chat/completions

📋 环境信息:
- 模式: ${process.env.NODE_ENV || 'development'}
- 月度token限制: ${process.env.MONTHLY_TOKEN_LIMIT || 1000000}
- 每日token限制: ${process.env.DAILY_TOKEN_LIMIT || 50000}
- CORS来源: ${process.env.CORS_ORIGIN || '默认'}

💡 使用说明:
1. 前端通过POST /v1/chat/completions调用
2. 请求体与DeepSeek官方API完全兼容
3. API Key已安全存储在服务器端
4. 用量自动统计和限制
      `);
    });
  } catch (error) {
    console.error('❌ 启动服务器失败:', error);
    process.exit(1);
  }
}

startServer();

// 优雅关闭
process.on('SIGINT', async () => {
  logger.info('收到SIGINT信号，正在关闭服务器...');
  await usageTracker.saveUsageData();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('收到SIGTERM信号，正在关闭服务器...');
  await usageTracker.saveUsageData();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', reason);
});