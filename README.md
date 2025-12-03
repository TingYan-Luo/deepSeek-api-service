# 代理DS接口调用的服务
用于个人使用的deepseek模型api接口调用的代理服务，方便前端项目直接使用，避免API_KEY暴露

## 安装和运行

1. 安装依赖
npm install
2. 创建 .env 文件（复制 .env 并填写你的API Key）
```
// DeepSeek配置
DS_API_KEY = 你的API Key
DEEPSEEK_API_URL=https://api.deepseek.com
// 服务器配置
PORT=3001
NODE_ENV=development
HOST=0.0.0.0
// 安全配置
CORS_ORIGIN=http://localhost:19006,http://localhost:3000
RATE_LIMIT_PER_MINUTE=60
// 成本控制配置
MONTHLY_TOKEN_LIMIT=1000000  # 每月token限制（100万）
DAILY_TOKEN_LIMIT=50000     # 每日token限制
MAX_TOKENS_PER_REQUEST=2000 # 每次请求最大tokens
ENABLE_USAGE_TRACKING=true  # 启用用量跟踪
// 模型配置
DEFAULT_MODEL=deepseek-chat
ALLOWED_MODELS=deepseek-chat,deepseek-coder
// 日志配置
LOG_LEVEL=info
LOG_TO_FILE=true
```


3. 启动服务器
npm run dev  # 开发模式（热重载）. 
npm start    # 生产模式