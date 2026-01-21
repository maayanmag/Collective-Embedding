# Deployment Guide for Collective Embedding

## Overview

Collective Embedding is a **full-stack Node.js application** with WebSocket server capabilities. It requires a backend server and cannot be deployed as a static site.

## ⚠️ Important: Netlify Limitation

**Netlify is for static websites only** and cannot run the Node.js server required for this application. The interactive features (real-time network updates, WebSocket connections, session management) will not work on Netlify.

## 🚀 Recommended Deployment Options

### 1. Railway (Recommended - Easy & Free)

Railway provides free Node.js hosting with automatic deployments.

**Steps:**
1. Go to [railway.app](https://railway.app)
2. Sign up with your GitHub account
3. Click "Deploy from GitHub repo"
4. Select `maayanmag/Collective-Embedding`
5. Railway will automatically detect it's a Node.js app
6. Set environment variables if needed:
   ```
   PORT=3000
   NODE_ENV=production
   ```
7. Deploy! Your app will be live at a Railway URL

### 2. Heroku

**Steps:**
1. Install Heroku CLI
2. In your project directory:
   ```bash
   heroku create collective-embedding-app
   git push heroku main
   heroku open
   ```

### 3. Render

**Steps:**
1. Go to [render.com](https://render.com)
2. Connect your GitHub repository
3. Select "Web Service"
4. Build command: `npm install`
5. Start command: `npm start`

### 4. DigitalOcean App Platform

**Steps:**
1. Go to [digitalocean.com/products/app-platform](https://www.digitalocean.com/products/app-platform/)
2. Connect GitHub repository
3. Configure as Node.js app
4. Deploy

## 🔧 Configuration Files Included

### For Railway/Heroku (`package.json`)
```json
{
  "scripts": {
    "start": "node server/index.js",
    "dev": "concurrently \"npm run server\" \"npm run client\""
  }
}
```

### For Netlify (Static Files Only - Limited Functionality)
The `netlify.toml` file will deploy only the static HTML files, but **none of the interactive features will work**.

## 📋 Environment Variables

For production deployment, you may want to set:

```
PORT=3000
NODE_ENV=production
MAX_PARTICIPANTS=20
SESSION_TIMEOUT=3600000
```

## 🛠 Local Development

```bash
npm install
npm run dev
# Opens on http://localhost:3000
```

## 🎯 Deployment Checklist

- [ ] Choose a Node.js hosting platform (Railway, Heroku, Render)
- [ ] Connect your GitHub repository
- [ ] Set environment variables if needed
- [ ] Deploy and test all features:
  - [ ] Session creation
  - [ ] Participant joining
  - [ ] Real-time network updates
  - [ ] WebSocket connections
  - [ ] Question flow automation

## 📞 Support

If you encounter deployment issues:
1. Check that the hosting platform supports Node.js and WebSockets
2. Verify all dependencies are installed correctly
3. Check server logs for any errors
4. Ensure the PORT environment variable is set correctly

---

**Note**: This application requires a full Node.js runtime environment and cannot function as a static website due to its real-time, interactive nature.
