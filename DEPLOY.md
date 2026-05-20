# 黑白棋 部署文档

## 项目结构

```
heibai/
├── index.html      # 前端页面（单文件，含 HTML/CSS/JS）
├── server.js       # WebSocket 服务器
├── package.json    # 依赖配置
└── DEPLOY.md       # 本文档
```

## 环境要求

| 依赖     | 最低版本 |
| -------- | -------- |
| Node.js  | 14.0+    |
| npm      | 6.0+     |

## 一、本地开发

```bash
cd heibai
npm install
npm start
```

浏览器访问 `http://localhost:8080`

自定义端口：

```bash
PORT=3000 npm start
# 或
npm start -- 3000
```

## 二、局域网部署

### 1. 安装依赖

```bash
cd heibai
npm install
```

### 2. 启动服务

```bash
PORT=8080 node server.js
```

### 3. 开放防火墙

```bash
# Ubuntu / Debian
sudo ufw allow 8080/tcp

# CentOS / RHEL
sudo firewall-cmd --add-port=8080/tcp --permanent
sudo firewall-cmd --reload
```

### 4. 访问

局域网内其他设备浏览器访问 `http://服务器IP:8080`

## 三、公网部署

### 方案 A：直接运行

```bash
# 安装 pm2（进程守护）
npm install -g pm2

# 启动
cd /path/to/heibai
PORT=8080 pm2 start server.js --name heibai

# 查看状态
pm2 status

# 查看日志
pm2 logs heibai

# 开机自启
pm2 startup
pm2 save
```

### 方案 B：Docker 部署

创建 `Dockerfile`：

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

构建并运行：

```bash
docker build -t heibai .
docker run -d -p 8080:8080 --name heibai --restart always heibai
```

### 方案 C：Nginx 反向代理

适合需要域名、HTTPS 的场景。

Nginx 配置：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

> WebSocket 需要 `Upgrade` 和 `Connection` 头，否则连接会失败。

### 云服务器安全组

在云服务商控制台放行对应端口（如 8080）的入站 TCP 流量。

## 四、打包传输

### 方式 1：scp

```bash
scp -r /home/yang/testapp/heibai user@服务器IP:/home/user/heibai
```

### 方式 2：打包后传输

```bash
# 打包（排除 node_modules）
tar czf heibai.tar.gz --exclude=node_modules heibai/

# 传输
scp heibai.tar.gz user@服务器IP:/home/user/

# 服务器上解压并安装
ssh user@服务器IP
cd /home/user
tar xzf heibai.tar.gz
cd heibai
npm install
```

### 方式 3：Git

```bash
# 本地初始化
cd heibai
git init
echo node_modules > .gitignore
git add .
git commit -m "init"

# 服务器克隆
git clone <仓库地址> heibai
cd heibai
npm install
```

## 五、配置说明

| 环境变量 | 默认值 | 说明     |
| -------- | ------ | -------- |
| `PORT`   | 8080   | 服务端口 |

重连超时（秒）：在 `server.js` 中修改 `RECONNECT_TIMEOUT`（默认 120000ms = 2 分钟）。
