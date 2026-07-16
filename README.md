# Folder2GitHub

A luxury minimal Next.js web app to upload local directories directly to a new GitHub repository from your browser. 

Powered by the browser **File System Access API** (no Git installation, CLI commands, or server-side file hosting needed) and the **GitHub Git Data API** (blobs → tree → commit → ref).

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the development server**:
   ```bash
   npm run dev
   ```

3. **Open the browser**:
   Navigate to [http://localhost:3000](http://localhost:3000) using **Google Chrome** or **Microsoft Edge** (required for the File System Access API).

## Configuration

The application is preconfigured with the following GitHub OAuth App credentials:
- **Client ID**: `Ov23livElJjbt2gA9LAf`
- **Client Secret**: `da1f03acf5184de3c16d45835141b5a17dee04ab`
- **Callback URL**: `http://localhost:3000/api/auth/callback`

## Features

- **Direct Upload Flow**: Reads folder contents and streams files straight to GitHub.
- **Gitignore Filtering**: Auto-skips standard dependencies and configurations (`node_modules`, `.git`, `.env`, `.next`, `dist`, `build`, etc.).
- **Live Compiling Animation**: Visual file compiling lists and data flowing stream animation.
- **Error Safeguards**: Warns for files larger than 50MB and handles expired tokens/empty folders gracefully.
