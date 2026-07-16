"use client";

import { useState, useEffect } from 'react';
import { createRepo, uploadFilesToRepo, calculateGitBlobSha, getRepoTree, uploadIncrementalChanges } from '@/lib/github';

export default function Home() {
  const [browserSupported, setBrowserSupported] = useState(true);
  const [loadingSession, setLoadingSession] = useState(true);
  const [session, setSession] = useState(null);
  
  // Steps: 'login' | 'select' | 'readme' | 'details' | 'upload' | 'success'
  const [step, setStep] = useState('login');
  
  // File variables
  const [selectedFolderName, setSelectedFolderName] = useState('');
  const [files, setFiles] = useState([]);
  const [fileCount, setFileCount] = useState(0);
  const [hasLargeFiles, setHasLargeFiles] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // README Builder state
  const [skipReadme, setSkipReadme] = useState(false);
  const [readmeTitle, setReadmeTitle] = useState('');
  const [readmeDescription, setReadmeDescription] = useState('');
  const [readmeInstall, setReadmeInstall] = useState('npm install');
  const [readmeUsage, setReadmeUsage] = useState('npm run dev');

  // Repo variables
  const [repoName, setRepoName] = useState('');
  const [repoNameSource, setRepoNameSource] = useState('none');
  const [repoDescription, setRepoDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);

  // Upload variables
  const [uploadStatus, setUploadStatus] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [uploadedUrl, setUploadedUrl] = useState('');

  // Incremental Update variables
  const [dirHandle, setDirHandle] = useState(null);
  const [existingConfig, setExistingConfig] = useState(null);
  const [incrementalChanges, setIncrementalChanges] = useState(null);
  const [commitMessage, setCommitMessage] = useState('Incremental update via Folder2GitHub');

  // Node modules & Git filter helper (Simple .gitignore parser)
  const isIgnored = (path) => {
    const parts = path.split('/');
    const ignoreList = ['node_modules', '.git', '.env', 'dist', 'build', '.next', 'out', '.folder2github.json'];
    
    return parts.some(part => {
      if (ignoreList.includes(part)) return true;
      if (part.startsWith('.') && part !== '.' && part !== '..') return true;
      return false;
    });
  };

  // Browser support check
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (!window.showDirectoryPicker) {
        setBrowserSupported(false);
      }
    }
  }, []);

  // Fetch session
  useEffect(() => {
    async function checkSession() {
      try {
        const res = await fetch('/api/session');
        if (res.ok) {
          const data = await res.json();
          setSession(data);
          setStep('select');
        }
      } catch (err) {
        console.error('Session fetch error:', err);
      } finally {
        setLoadingSession(false);
      }
    }
    checkSession();
  }, []);

  const handleLogout = async () => {
    await fetch('/api/session', { method: 'DELETE' });
    setSession(null);
    setStep('login');
  };

  // Auto-detect README values during directory pick
  const pickFolder = async () => {
    try {
      setErrorMsg('');
      setFiles([]);
      setHasLargeFiles(false);

      if (!window.showDirectoryPicker) {
        setErrorMsg('Directory Picker API is not supported on this browser.');
        return;
      }

      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setSelectedFolderName(dirHandle.name);
      setDirHandle(dirHandle);

      let config = null;
      console.log("[TRACE 1] Folder selected:", dirHandle.name);
      
      // Enumerate root files to see if it's there
      const rootEntries = [];
      for await (const entry of dirHandle.values()) {
        rootEntries.push(entry.name);
      }
      console.log("[TRACE 2] Root files/folders found:", rootEntries);
      console.log(`[TRACE 3] Does '.folder2github.json' exist in list?`, rootEntries.includes('.folder2github.json'));

      try {
        console.log("[TRACE 4] Attempting to call getFileHandle('.folder2github.json')...");
        const configHandle = await dirHandle.getFileHandle('.folder2github.json');
        console.log("[TRACE 5] getFileHandle succeeded, reading file...");
        const configFile = await configHandle.getFile();
        const configText = await configFile.text();
        console.log("[TRACE 6] Raw file contents:", configText);
        
        config = JSON.parse(configText);
        console.log("[TRACE 7] Successfully parsed existing config:", config);
        setExistingConfig(config);
      } catch (e) {
        if (e.name === 'NotFoundError') {
          console.log("[TRACE DEBUG] .folder2github.json not found. Proceeding as new repo.");
          setExistingConfig(null);
        } else {
          console.error("[TRACE ERROR] Failed to read/parse .folder2github.json:", e.name, e.message, e);
          throw new Error(`Failed to read repository configuration: ${e.message}`);
        }
      }
      
      // Prefill names if user hasn't explicitly edited them
      if (repoNameSource !== 'user-edited') {
        const sanitizedName = dirHandle.name
          .toLowerCase()
          .replace(/[^a-z0-9-_]/g, '-');
        
        if (config && config.name) {
          setRepoName(config.name);
          setRepoNameSource('auto-config');
        } else {
          setRepoName(sanitizedName);
          setRepoNameSource('auto-folder');
        }
      }
      setReadmeTitle(dirHandle.name);

      const collectedFiles = [];
      let largeFilesFound = false;
      let detectedDesc = 'Pushed via Folder2GitHub.';
      let detectedInstall = 'npm install';
      let detectedUsage = 'npm run dev';

      async function scanDirectory(handle, currentPath = '') {
        for await (const entry of handle.values()) {
          const relativePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
          
          if (isIgnored(relativePath)) {
            continue;
          }

          if (entry.kind === 'file') {
            const file = await entry.getFile();
            const sizeInMB = file.size / (1024 * 1024);
            if (sizeInMB > 50) {
              largeFilesFound = true;
            }

            // Detect info from package.json
            if (entry.name === 'package.json') {
              try {
                const text = await file.text();
                const pkg = JSON.parse(text);
                if (pkg.description) detectedDesc = pkg.description;
                if (pkg.scripts && pkg.scripts.dev) {
                  detectedUsage = 'npm run dev';
                } else if (pkg.scripts && pkg.scripts.start) {
                  detectedUsage = 'npm start';
                }
              } catch (e) {}
            }

            // Custom install steps detections
            if (entry.name === 'requirements.txt') {
              detectedInstall = 'pip install -r requirements.txt';
              detectedUsage = 'python app.py';
            } else if (entry.name === 'Gemfile') {
              detectedInstall = 'bundle install';
              detectedUsage = 'bundle exec rails server';
            }

            collectedFiles.push({
              path: relativePath,
              fileHandle: file,
            });
          } else if (entry.kind === 'directory') {
            await scanDirectory(entry, relativePath);
          }
        }
      }

      await scanDirectory(dirHandle);

      if (collectedFiles.length === 0) {
        setErrorMsg('The selected folder is empty or all files are ignored by default rule.');
        return;
      }

      setReadmeDescription(detectedDesc);
      setReadmeInstall(detectedInstall);
      setReadmeUsage(detectedUsage);
      
      setFiles(collectedFiles);
      setFileCount(collectedFiles.length);
      setHasLargeFiles(largeFilesFound);

      if (config) {
        setStep('fetch_remote');
        setUploadStatus('Comparing local files with remote repository...');
        calculateDiff(config, collectedFiles);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error("pickFolder Error: " + (err.message || "Unknown Error"), err);
        setErrorMsg(`Error selecting folder: ${err.name} - ${err.message || "Unknown error"}`);
      }
    }
  };

  const calculateDiff = async (config, localFiles) => {
    try {
      const remoteTree = await getRepoTree(session.token, config.owner, config.name, config.lastCommitSha);
      const remoteMap = new Map();
      remoteTree.forEach(item => {
        if (item.type === 'blob') {
          remoteMap.set(item.path, item.sha);
        }
      });

      const added = [];
      const modified = [];
      const localMap = new Set();

      for (const file of localFiles) {
        localMap.add(file.path);
        try {
          const buffer = await file.fileHandle.arrayBuffer();
          const localSha = await calculateGitBlobSha(buffer);
          file.content = buffer; // cache for upload
          
          if (!remoteMap.has(file.path)) {
            added.push(file);
          } else if (remoteMap.get(file.path) !== localSha) {
            modified.push(file);
          }
        } catch (e) {
          console.warn(`Skipped unreadable file during diff: ${file.path}`);
        }
      }

      const deleted = [];
      for (const [remotePath] of remoteMap.entries()) {
        if (!localMap.has(remotePath)) {
          deleted.push({ path: remotePath });
        }
      }

      setIncrementalChanges({ added, modified, deleted });
      setStep('review');
    } catch (err) {
      console.error(err);
      setErrorMsg('Failed to fetch remote repository. It may have been deleted. Falling back to new repo flow.');
      setExistingConfig(null);
    }
  };

  const handleNextToReadme = () => {
    if (files.length > 0) {
      setStep('readme');
    }
  };

  const handleNextToDetails = () => {
    setStep('details');
  };

  // Compile full markdown string for README
  const getReadmeMarkdown = () => {
    return `# ${readmeTitle}

${readmeDescription}

## Installation

\`\`\`bash
${readmeInstall}
\`\`\`

## Usage

\`\`\`bash
${readmeUsage}
\`\`\`
`;
  };

  // Upload handler
  const handleUpload = async () => {
    setStep('upload');
    setUploadStatus('Reading local files...');
    setProgressPercent(5);

    try {
      const filesToUpload = [];
      for (let i = 0; i < files.length; i++) {
        const fileObj = files[i];
        // Ensure we don't upload an existing readme if we are building one
        if (fileObj.path.toLowerCase() === 'readme.md' && !skipReadme) {
          continue; 
        }
        try {
          const arrayBuffer = await fileObj.fileHandle.arrayBuffer();
          filesToUpload.push({
            path: fileObj.path,
            content: arrayBuffer,
          });
        } catch (readErr) {
          console.warn(`Skipped unreadable file: ${fileObj.path}`, readErr);
          // Optional: You could update uploadStatus here to show a warning, 
          // but we'll just skip to keep the upload moving.
        }
      }

      // If README generation is enabled, append it to files lists
      if (!skipReadme) {
        const readmeContent = getReadmeMarkdown();
        filesToUpload.push({
          path: 'README.md',
          content: readmeContent,
        });
      }

      setUploadStatus('Creating GitHub repository...');
      setProgressPercent(15);
      const repoDetails = await createRepo(session.token, {
        name: repoName,
        description: repoDescription || readmeDescription || 'Uploaded via Folder2GitHub',
        isPrivate: isPrivate,
      });

      const owner = repoDetails.owner.login;
      const name = repoDetails.name;

      setUploadStatus('Uploading files via Git Data API...');
      const result = await uploadFilesToRepo(
        session.token,
        owner,
        name,
        filesToUpload,
        (current, total, currentFile) => {
          const ratio = current / total;
          const pct = Math.round(20 + ratio * 75);
          setProgressPercent(pct);
          setUploadStatus(`Uploading: ${currentFile} (${current}/${total})`);
        }
      );

      setProgressPercent(100);
      setUploadedUrl(result.url);
      
      // Save config locally BEFORE showing success
      try {
        console.log("[TRACE A] Attempting to write .folder2github.json config...");
        const configData = {
          owner,
          name,
          defaultBranch: 'main',
          lastCommitSha: result.commitSha
        };
        const configString = JSON.stringify(configData, null, 2);
        console.log("[TRACE B] Data to write:", configString);

        const configHandle = await dirHandle.getFileHandle('.folder2github.json', { create: true });
        const writable = await configHandle.createWritable();
        await writable.write(configString);
        await writable.close();
        console.log("[TRACE C] Successfully saved .folder2github.json config. Write operation completed.");
      } catch (err) {
        console.error('[TRACE ERROR] Could not save .folder2github.json config:', err.name, err.message, err);
      }

      setStep('success');
    } catch (err) {
      console.error(err);
      if (err.message === 'TOKEN_EXPIRED') {
        setErrorMsg('Your GitHub session has expired. Please log in again.');
        setStep('login');
      } else if (err.message.includes('Repository creation failed') || err.message.includes('name already exists')) {
        setErrorMsg(`A repository named "${repoName}" already exists on your GitHub account. Please go back and change the Repository Name, or delete the old repository on GitHub first.`);
        setStep('details');
      } else {
        setErrorMsg(err.message || 'An error occurred during upload.');
        setStep('details');
      }
    }
  };

  const handleIncrementalUpload = async () => {
    setStep('upload');
    setUploadStatus('Starting incremental update...');
    setProgressPercent(10);

    try {
      const result = await uploadIncrementalChanges(
        session.token,
        existingConfig.owner,
        existingConfig.name,
        existingConfig.defaultBranch || 'main',
        existingConfig.lastCommitSha,
        existingConfig.lastCommitSha,
        incrementalChanges.added,
        incrementalChanges.modified,
        incrementalChanges.deleted,
        commitMessage,
        (current, total, msg) => {
          if (typeof msg === 'string' && msg.includes('Creating')) {
            setUploadStatus(msg);
          } else if (total > 0) {
            const pct = Math.round(10 + (current / total) * 80);
            setProgressPercent(pct);
            setUploadStatus(`Uploading changed files: ${current}/${total}`);
          }
        }
      );

      setProgressPercent(100);
      setUploadedUrl(result.url);

      // Update local config
      try {
        const configHandle = await dirHandle.getFileHandle('.folder2github.json', { create: true });
        const writable = await configHandle.createWritable();
        await writable.write(JSON.stringify({
          ...existingConfig,
          lastCommitSha: result.commitSha
        }, null, 2));
        await writable.close();
      } catch (err) {
        console.warn('Could not update .folder2github.json config', err);
      }

      setStep('success');
    } catch (err) {
      console.error(err);
      if (err.message === 'TOKEN_EXPIRED') {
        setErrorMsg('Your GitHub session has expired. Please log in again.');
        setStep('login');
      } else {
        setErrorMsg(err.message || 'An error occurred during incremental upload.');
        setStep('review');
      }
    }
  };

  const handleUnlink = async () => {
    if (confirm('Are you sure you want to unlink this folder from the GitHub repository? This will not delete the remote repository, but will remove the local link.')) {
      try {
        await dirHandle.removeEntry('.folder2github.json');
      } catch (e) {}
      setExistingConfig(null);
      setStep('readme');
    }
  };

  const handleDownloadSetupScript = () => {
    let isWindows = true;
    if (typeof window !== 'undefined') {
      isWindows = window.navigator.userAgent.toLowerCase().includes('windows');
    }
    
    // Extract owner and repo from uploadedUrl (e.g. https://github.com/owner/repo)
    const urlParts = uploadedUrl.replace(/\/$/, '').split('/');
    const repo = urlParts.pop();
    const owner = urlParts.pop();

    const scriptContent = isWindows ? 
`@echo off
echo Linking this folder to GitHub...
git init
git remote add origin https://github.com/${owner}/${repo}.git
git branch -M main
git add .
git commit -m "Initial commit (synced from Folder2GitHub)"
git push -u origin main --force
echo Done! You can now use VS Code, Antigravity, or any git tool normally.
pause
` : 
`#!/bin/bash
echo "Linking this folder to GitHub..."
git init
git remote add origin https://github.com/${owner}/${repo}.git
git branch -M main
git add .
git commit -m "Initial commit (synced from Folder2GitHub)"
git push -u origin main --force
echo "Done! You can now use VS Code, Antigravity, or any git tool normally."
`;

    const blob = new Blob([scriptContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isWindows ? 'setup.bat' : 'setup.sh';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!browserSupported) {
    return (
      <div className="main-wrapper">
        <header className="asymmetric-grid">
          <div className="hero-left">
            <h1 className="hero-headline">Folder2GitHub</h1>
            <h2 className="hero-subheadline">Browser Not Supported</h2>
            <p className="hero-body">
              Please use Google Chrome or Microsoft Edge. This web app relies on the browser File System Access API to pick and upload local directories.
            </p>
          </div>
          <div className="hero-right">
            <img src="/readme_builder_light.png" alt="Upload Vector Illustration" className="hero-image" />
          </div>
        </header>
      </div>
    );
  }

  const [avatarError, setAvatarError] = useState(false);

  return (
    <>
      {/* Sticky top thin minimal navbar */}
      <nav className="navbar">
        <div className="nav-logo">Folder2GitHub</div>
        <div className="nav-actions">
          {session ? (
            <div className="user-profile">
              {session.avatarUrl && !avatarError ? (
                <img 
                  src={session.avatarUrl} 
                  alt="Avatar" 
                  className="user-avatar" 
                  onError={() => setAvatarError(true)}
                  style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }}
                />
              ) : (
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent-color)',
                  color: '#16151A',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: '600',
                  fontSize: '0.85rem'
                }}>
                  {session.username ? session.username.charAt(0).toUpperCase() : 'U'}
                </div>
              )}
              <span>{session.username}</span>
              <button 
                onClick={handleLogout} 
                style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', padding: '0 4px', textDecoration: 'underline', font: 'inherit' }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <a href="/api/auth/github" className="btn" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
              Sign in
            </a>
          )}
          {uploadedUrl && (
            <a href={uploadedUrl} target="_blank" rel="noopener noreferrer" title="View repository on GitHub">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          )}
        </div>
      </nav>

      <div className="main-wrapper">
        {/* Step 1: Login / Hero section (Asymmetric Split) */}
        {step === 'login' && (
          <header className="asymmetric-grid">
            <div className="hero-left">
              <h1 className="hero-headline">Folder2GitHub</h1>
              <h2 className="hero-subheadline">Upload directories directly to GitHub</h2>
              <p className="hero-body">
                Authenticate, choose your local project directory, and stream it straight to a new GitHub repository. No local Git commands or installations required.
              </p>
              <a href="/api/auth/github" className="btn btn-primary">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                Sign in with GitHub
              </a>
            </div>
            <div className="hero-right">
              <img src="/readme_builder_light.png" alt="Light clean minimal illustration line art" className="hero-image" />
            </div>
          </header>
        )}

        <main>
          {errorMsg && (
            <div className="alert alert-danger" style={{ marginBottom: '24px', maxWidth: '680px' }}>
              {errorMsg}
            </div>
          )}

          {/* Step 2: Select Folder (Asymmetric column grid) */}
          {step === 'select' && (
            <div className="asymmetric-grid">
              <div className="custom-card">
                <div className="step-header">
                  <h2>Select Directory</h2>
                  <p className="step-subtitle">Pick the local directory you want to upload</p>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <button onClick={pickFolder} className="btn" style={{ padding: '24px', borderStyle: 'solid', borderWidth: '1px', borderColor: 'var(--accent-color)', justifyContent: 'center' }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    {selectedFolderName ? `Reselect Folder: ${selectedFolderName}` : 'Choose Local Folder'}
                  </button>

                  {files.length > 0 && (
                    <div style={{ animation: 'fadeIn 0.3s ease' }}>
                      {hasLargeFiles && (
                        <div className="alert alert-warning" style={{ marginTop: '16px' }}>
                          <strong>Warning:</strong> One or more selected files exceed 50MB. Upload might fail on standard Git APIs.
                        </div>
                      )}

                      <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: '24px' }}>
                        <button onClick={handleNextToReadme} className="btn btn-primary">
                          Next: README Builder
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Tree preview on the right */}
              <div className="step-preview-container">
                <h3 className="preview-title">Directory Preview</h3>
                {files.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Selected Files:</span>
                      <strong style={{ fontSize: '0.9rem', color: 'var(--accent-color)' }}>{fileCount} total</strong>
                    </div>
                    <div className="compiling-tree">
                      {files.slice(0, 100).map((f, i) => (
                        <div key={f.path} className="tree-file" style={{ animationDelay: `${i * 8}ms` }}>
                          <span className="path">{f.path}</span>
                          <span className="size">✓</span>
                        </div>
                      ))}
                      {files.length > 100 && (
                        <div className="tree-file" style={{ color: 'var(--accent-color)' }}>
                          <span>...and {files.length - 100} more files</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    Select a local directory to display compile preview.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3: README Builder (Asymmetric Column Grid: Form on Left, Markdown Render on Right) */}
          {step === 'readme' && (
            <div className="asymmetric-grid">
              <div className="custom-card">
                <div className="step-header">
                  <h2>README.md Builder</h2>
                  <p className="step-subtitle">Auto-detected settings draft your root documentation</p>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label className="user-profile" style={{ cursor: 'pointer', gap: '8px' }}>
                    <input 
                      type="checkbox" 
                      checked={skipReadme} 
                      onChange={(e) => setSkipReadme(e.target.checked)} 
                    />
                    <span>Skip generated README.md</span>
                  </label>
                </div>

                {!skipReadme && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div className="form-group">
                      <label htmlFor="readme-title">Project Title</label>
                      <input
                        id="readme-title"
                        type="text"
                        className="form-input"
                        value={readmeTitle}
                        onChange={(e) => setReadmeTitle(e.target.value)}
                        placeholder="Project Name"
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="readme-desc">One-line Description</label>
                      <textarea
                        id="readme-desc"
                        className="form-textarea"
                        value={readmeDescription}
                        onChange={(e) => setReadmeDescription(e.target.value)}
                        placeholder="Describe what this project is all about."
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="readme-install">Installation commands</label>
                      <input
                        id="readme-install"
                        type="text"
                        className="form-input"
                        value={readmeInstall}
                        onChange={(e) => setReadmeInstall(e.target.value)}
                        placeholder="npm install"
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="readme-usage">Usage execution script</label>
                      <input
                        id="readme-usage"
                        type="text"
                        className="form-input"
                        value={readmeUsage}
                        onChange={(e) => setReadmeUsage(e.target.value)}
                        placeholder="npm run dev"
                      />
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '30px' }}>
                  <button onClick={() => setStep('select')} className="btn">
                    Back
                  </button>
                  <button onClick={handleNextToDetails} className="btn btn-primary">
                    Next: Destination Repo
                  </button>
                </div>
              </div>

              {/* Rendered Live README Markdown Panel on the Right */}
              <div className="step-preview-container">
                <h3 className="preview-title">Live README Preview</h3>
                {!skipReadme ? (
                  <div className="readme-preview">
                    <h1>{readmeTitle || 'Project Title'}</h1>
                    <p>{readmeDescription || 'No description provided.'}</p>
                    <h2>Installation</h2>
                    <pre><code>{readmeInstall}</code></pre>
                    <h2>Usage</h2>
                    <pre><code>{readmeUsage}</code></pre>
                  </div>
                ) : (
                  <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    README generation skipped.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Enter Repo Details (Asymmetric Grid) */}
          {step === 'details' && (
            <div className="asymmetric-grid">
              <div className="custom-card">
                <div className="step-header">
                  <h2>Repository Destination</h2>
                  <p className="step-subtitle">Configure your destination GitHub repository</p>
                </div>

                <div className="form-group">
                  <label htmlFor="repo-name">Repository Name</label>
                  <input
                    id="repo-name"
                    type="text"
                    className="form-input"
                    value={repoName}
                    onChange={(e) => {
                      setRepoName(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-'));
                      setRepoNameSource('user-edited');
                    }}
                    placeholder="my-cool-project"
                    required
                  />
                  {repoNameSource === 'auto-folder' && (
                    <small style={{ color: 'var(--text-secondary)', marginTop: '6px', display: 'block', fontSize: '0.8rem' }}>
                      <em>Auto-filled from folder name. You can change this.</em>
                    </small>
                  )}
                  {repoNameSource === 'auto-config' && (
                    <small style={{ color: 'var(--text-secondary)', marginTop: '6px', display: 'block', fontSize: '0.8rem' }}>
                      <em>Loaded from previous upload configuration.</em>
                    </small>
                  )}
                </div>

                <div className="form-group">
                  <label htmlFor="repo-desc">Description (Optional)</label>
                  <input
                    id="repo-desc"
                    type="text"
                    className="form-input"
                    value={repoDescription}
                    onChange={(e) => setRepoDescription(e.target.value)}
                    placeholder="Uploaded via Folder2GitHub"
                  />
                </div>

                <div className="form-group">
                  <label>Visibility</label>
                  <div className="radio-group">
                    <div 
                      className={`radio-card ${!isPrivate ? 'active' : ''}`}
                      onClick={() => setIsPrivate(false)}
                    >
                      <h4>Public</h4>
                      <span>Anyone on the internet can see this repository.</span>
                    </div>
                    <div 
                      className={`radio-card ${isPrivate ? 'active' : ''}`}
                      onClick={() => setIsPrivate(true)}
                    >
                      <h4>Private</h4>
                      <span>Only you can see this repository.</span>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '40px' }}>
                  <button onClick={() => setStep('readme')} className="btn">
                    Back
                  </button>
                  <button 
                    onClick={handleUpload} 
                    className="btn btn-primary"
                    disabled={!repoName.trim()}
                  >
                    Create & Upload
                  </button>
                </div>
              </div>

              {/* Upload summary panel on the right */}
              <div className="step-preview-container">
                <h3 className="preview-title">Upload Summary</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '0.9rem' }}>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Source Folder:</span>
                    <div className="mono-text" style={{ marginTop: '4px', color: 'var(--accent-color)' }}>{selectedFolderName}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Total Files:</span>
                    <div style={{ fontWeight: '600', marginTop: '4px' }}>{fileCount} files</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Target Repository:</span>
                    <div className="mono-text" style={{ marginTop: '4px', color: 'var(--accent-color)' }}>{repoName}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Include README:</span>
                    <div style={{ marginTop: '4px' }}>{!skipReadme ? 'Yes (Generated)' : 'No'}</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Incremental Step: Fetch Remote (Loading) */}
          {step === 'fetch_remote' && (
            <div className="centered-layout">
              <div className="custom-card" style={{ textAlign: 'center' }}>
                <div className="step-header">
                  <h2>{uploadStatus || 'Fetching repository data...'}</h2>
                  <p className="step-subtitle">Comparing local folder to {existingConfig?.owner}/{existingConfig?.name}</p>
                </div>
                <div className="upload-animation-container">
                  <div className="flow-dot" style={{ animationDelay: '0.1s' }}></div>
                  <div className="flow-dot" style={{ animationDelay: '0.3s' }}></div>
                  <div className="flow-dot" style={{ animationDelay: '0.5s' }}></div>
                </div>
              </div>
            </div>
          )}

          {/* Incremental Step: Review Changes */}
          {step === 'review' && incrementalChanges && (
            <div className="asymmetric-grid">
              <div className="custom-card">
                <div className="step-header">
                  <h2>Review Changes</h2>
                  <p className="step-subtitle">You are about to push an incremental update to {existingConfig.owner}/{existingConfig.name}</p>
                </div>

                <div className="form-group">
                  <label htmlFor="commit-msg">Commit Message</label>
                  <input
                    id="commit-msg"
                    type="text"
                    className="form-input"
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    placeholder="Incremental update via Folder2GitHub"
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'rgba(46, 160, 67, 0.1)', border: '1px solid rgba(46, 160, 67, 0.2)', borderRadius: '6px' }}>
                    <span style={{ color: '#3fb950', fontWeight: 'bold' }}>Added</span>
                    <span>{incrementalChanges.added.length} files</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'rgba(210, 153, 34, 0.1)', border: '1px solid rgba(210, 153, 34, 0.2)', borderRadius: '6px' }}>
                    <span style={{ color: '#d29922', fontWeight: 'bold' }}>Modified</span>
                    <span>{incrementalChanges.modified.length} files</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'rgba(248, 81, 73, 0.1)', border: '1px solid rgba(248, 81, 73, 0.2)', borderRadius: '6px' }}>
                    <span style={{ color: '#f85149', fontWeight: 'bold' }}>Deleted</span>
                    <span>{incrementalChanges.deleted.length} files</span>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '40px' }}>
                  <button onClick={handleUnlink} className="btn" style={{ color: 'var(--text-secondary)' }}>
                    Unlink from Repo
                  </button>
                  <button 
                    onClick={handleIncrementalUpload} 
                    className="btn btn-primary"
                    disabled={(incrementalChanges.added.length + incrementalChanges.modified.length + incrementalChanges.deleted.length) === 0}
                  >
                    Commit & Push
                  </button>
                </div>
              </div>

              {/* Changes Preview Panel */}
              <div className="step-preview-container">
                <h3 className="preview-title">Changed Files</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', maxHeight: '500px' }}>
                  {incrementalChanges.added.map(f => (
                    <div key={f.path} style={{ display: 'flex', gap: '8px', fontSize: '0.85rem' }}>
                      <span style={{ color: '#3fb950' }}>+</span>
                      <span className="mono-text">{f.path}</span>
                    </div>
                  ))}
                  {incrementalChanges.modified.map(f => (
                    <div key={f.path} style={{ display: 'flex', gap: '8px', fontSize: '0.85rem' }}>
                      <span style={{ color: '#d29922' }}>M</span>
                      <span className="mono-text">{f.path}</span>
                    </div>
                  ))}
                  {incrementalChanges.deleted.map(f => (
                    <div key={f.path} style={{ display: 'flex', gap: '8px', fontSize: '0.85rem' }}>
                      <span style={{ color: '#f85149' }}>-</span>
                      <span className="mono-text" style={{ textDecoration: 'line-through' }}>{f.path}</span>
                    </div>
                  ))}
                  {(incrementalChanges.added.length + incrementalChanges.modified.length + incrementalChanges.deleted.length) === 0 && (
                    <div style={{ color: 'var(--text-muted)' }}>No changes detected. Your local folder matches the repository.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 5: Upload Progress (Tailored Centered Layout for focus state) */}
          {step === 'upload' && (
            <div className="centered-layout">
              <div className="custom-card" style={{ textAlign: 'center' }}>
                <div className="step-header" style={{ textAlign: 'left' }}>
                  <h2>Compiling & Direct Uploading</h2>
                  <p className="step-subtitle">Please keep this window open while we push blobs to GitHub</p>
                </div>

                <div className="upload-animation-container">
                  <div className="node-icon accented">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                  </div>

                  <div className="flow-connector">
                    <div className="flow-dot"></div>
                    <div className="flow-dot" style={{ animationDelay: '0.5s' }}></div>
                    <div className="flow-dot" style={{ animationDelay: '1s' }}></div>
                  </div>

                  <div className="node-icon accented">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2">
                      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path>
                    </svg>
                  </div>
                </div>

                <div style={{ background: 'rgba(255,255,255,0.02)', height: '4px', borderRadius: '2px', width: '100%', overflow: 'hidden', margin: '20px 0' }}>
                  <div 
                    style={{ 
                      background: 'var(--accent-color)', 
                      height: '100%', 
                      width: `${progressPercent}%`, 
                      transition: 'width 0.4s ease' 
                    }}
                  ></div>
                </div>

                <p className="progress-text">{uploadStatus}</p>
                <div style={{ fontSize: '2rem', fontFamily: 'var(--font-serif)', color: 'var(--accent-color)', marginTop: '16px', fontWeight: '300' }}>
                  {progressPercent}% Completed
                </div>
              </div>
            </div>
          )}

          {/* Step 6: Success Screen (Tailored Centered Layout for focus state) */}
          {step === 'success' && (
            <div className="centered-layout">
              <div className="custom-card" style={{ textAlign: 'center' }}>
                <div className="step-header" style={{ textAlign: 'left' }}>
                  <h2>Upload Complete</h2>
                  <p className="step-subtitle">Your directory has been pushed to GitHub</p>
                </div>

                <div style={{ margin: '40px 0' }}>
                  <div className="node-icon accented" style={{ margin: '0 auto 24px auto', width: '80px', height: '80px' }}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                      <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                  </div>
                  <h3 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Success</h3>
                  <p style={{ color: 'var(--text-secondary)' }}>
                    Created repository: <span className="mono-text" style={{ color: 'var(--accent-color)' }}>{repoName}</span>
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '360px', margin: '0 auto' }}>
                  <a href={uploadedUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
                    Open on GitHub
                  </a>

                  {/* Git Setup Script Download */}
                  {!existingConfig && (
                    <div style={{ padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }}>
                      <p style={{ fontSize: '0.85rem', marginBottom: '12px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                        Save this file inside your project folder, then double-click it to run. After that, use VS Code, Antigravity, or any git tool normally for future changes — you won't need to come back to this uploader again for this project.
                      </p>
                      <button onClick={handleDownloadSetupScript} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '8px' }}>
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                          <polyline points="7 10 12 15 17 10"></polyline>
                          <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Link this folder to Git
                      </button>
                      <p style={{ fontSize: '0.75rem', marginTop: '12px', color: 'var(--text-muted)' }}>
                        <em>Note: This requires <a href="https://git-scm.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-color)', textDecoration: 'underline' }}>Git</a> to be installed locally.</em>
                      </p>
                    </div>
                  )}

                  <button 
                    onClick={() => {
                      setFiles([]);
                      setFileCount(0);
                      setSelectedFolderName('');
                      setStep('select');
                    }} 
                    className="btn"
                  >
                    Upload another folder
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
