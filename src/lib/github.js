/**
 * GitHub API helper module for creating repositories and uploading files
 * using the Git Data API (Blobs -> Tree -> Commit -> Refs).
 */

async function githubRequest(url, token, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Folder2GitHub',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });
  
  if (!response.ok) {
    let errorData = null;
    try {
      errorData = await response.json();
    } catch (e) {}
    
    if (response.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    
    throw new Error(errorData?.message || `GitHub API request failed: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Creates a repository for the authenticated user.
 */
export async function createRepo(token, { name, description, isPrivate }) {
  // First get the user's details to confirm login and check if we are acting on user or org
  // (Assuming personal repos for this simple version)
  return githubRequest('https://api.github.com/user/repos', token, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      private: isPrivate,
      auto_init: true, // Auto-initialize with an empty README to establish a default branch and base commit
    }),
  });
}

/**
 * Uploads files using Git Data API.
 * Files is an array of objects: { path: string, content: ArrayBuffer or string }
 */
export async function uploadFilesToRepo(token, owner, repo, files, onProgress) {
  // 1. Get default branch ref (main or master)
  let refData;
  try {
    refData = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`, token);
  } catch (e) {
    // Try master fallback if main doesn't exist
    refData = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/master`, token);
  }

  const branchName = refData.ref.replace('refs/heads/', '');
  const lastCommitSha = refData.object.sha;

  // Get last commit details to retrieve its base tree
  const lastCommit = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/commits/${lastCommitSha}`, token);
  const baseTreeSha = lastCommit.tree.sha;

  const totalFiles = files.length;
  const treeItems = [];

  // 2. Upload blobs in chunks to avoid rate limiting and monitor progress
  // We upload in batches of 5 concurrent requests
  const BATCH_SIZE = 5;
  
  for (let i = 0; i < totalFiles; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    
    const blobPromises = batch.map(async (file, index) => {
      const fileIdx = i + index;
      try {
        let contentBase64;
        if (typeof file.content === 'string') {
          contentBase64 = btoa(unescape(encodeURIComponent(file.content)));
        } else {
          // File is ArrayBuffer
          const bytes = new Uint8Array(file.content);
          let binary = '';
          const len = bytes.byteLength;
          for (let b = 0; b < len; b++) {
            binary += String.fromCharCode(bytes[b]);
          }
          contentBase64 = btoa(binary);
        }

        const blobResult = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, token, {
          method: 'POST',
          body: JSON.stringify({
            content: contentBase64,
            encoding: 'base64',
          }),
        });

        // Add to tree array
        treeItems.push({
          path: file.path,
          mode: '100644', // normal file
          type: 'blob',
          sha: blobResult.sha,
        });

        if (onProgress) {
          onProgress(fileIdx + 1, totalFiles, file.path);
        }
      } catch (err) {
        console.error(`Failed to create blob for ${file.path}:`, err);
        throw err;
      }
    });

    await Promise.all(blobPromises);
  }

  // 3. Create the new Tree
  onProgress(totalFiles, totalFiles, 'Creating Git tree...');
  const newTree = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems,
    }),
  });

  // 4. Create the Commit pointing to the new Tree
  onProgress(totalFiles, totalFiles, 'Creating commit...');
  const newCommit = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message: 'Upload files via Folder2GitHub',
      tree: newTree.sha,
      parents: [lastCommitSha],
    }),
  });

  // 5. Update Branch Ref to point to the new Commit
  onProgress(totalFiles, totalFiles, 'Updating branch reference...');
  await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`, token, {
    method: 'PATCH',
    body: JSON.stringify({
      sha: newCommit.sha,
      force: false,
    }),
  });

  onProgress(totalFiles, totalFiles, 'Upload completed!');
  return {
    url: `https://github.com/${owner}/${repo}`,
    commitSha: newCommit.sha,
    treeSha: newTree.sha
  };
}

/**
 * Calculates the Git SHA-1 hash for a blob.
 */
export async function calculateGitBlobSha(arrayBuffer) {
  const prefix = `blob ${arrayBuffer.byteLength}\0`;
  const prefixBuffer = new TextEncoder().encode(prefix);
  
  const combined = new Uint8Array(prefixBuffer.length + arrayBuffer.byteLength);
  combined.set(prefixBuffer, 0);
  combined.set(new Uint8Array(arrayBuffer), prefixBuffer.length);
  
  const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetches the remote tree structure recursively.
 */
export async function getRepoTree(token, owner, repo, commitSha) {
  const treeData = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`, token);
  return treeData.tree;
}

/**
 * Uploads incremental changes.
 */
export async function uploadIncrementalChanges(token, owner, repo, branch, baseTreeSha, lastCommitSha, addedFiles, modifiedFiles, deletedFiles, commitMessage, onProgress) {
  const totalUploads = addedFiles.length + modifiedFiles.length;
  let currentProgress = 0;
  
  const treeItems = [];
  const filesToUpload = [...addedFiles, ...modifiedFiles];
  
  const BATCH_SIZE = 5;
  for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
    const batch = filesToUpload.slice(i, i + BATCH_SIZE);
    
    const blobPromises = batch.map(async (file) => {
      try {
        const bytes = new Uint8Array(file.content);
        let binary = '';
        for (let b = 0; b < bytes.byteLength; b++) {
          binary += String.fromCharCode(bytes[b]);
        }
        const contentBase64 = btoa(binary);

        const blobResult = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, token, {
          method: 'POST',
          body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
        });

        treeItems.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blobResult.sha,
        });

        currentProgress++;
        if (onProgress) onProgress(currentProgress, totalUploads, file.path);
      } catch (err) {
        console.error(`Failed to create blob for ${file.path}:`, err);
        throw err;
      }
    });

    await Promise.all(blobPromises);
  }

  for (const file of deletedFiles) {
    treeItems.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: null
    });
  }

  if (onProgress) onProgress(totalUploads, totalUploads, 'Creating Git tree...');
  const newTree = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });

  if (onProgress) onProgress(totalUploads, totalUploads, 'Creating commit...');
  const newCommit = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message: commitMessage || 'Incremental update via Folder2GitHub', tree: newTree.sha, parents: [lastCommitSha] }),
  });

  if (onProgress) onProgress(totalUploads, totalUploads, 'Updating branch reference...');
  await githubRequest(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });

  if (onProgress) onProgress(totalUploads, totalUploads, 'Upload completed!');
  
  return {
    url: `https://github.com/${owner}/${repo}`,
    commitSha: newCommit.sha,
    treeSha: newTree.sha
  };
}
