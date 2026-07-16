@echo off
echo Linking this folder to GitHub...
git init
git remote add origin https://github.com/Coder-vibhi/git-hub-tool.git
git branch -M main
git add .
git commit -m "Initial commit (synced from Folder2GitHub)"
git push -u origin main --force
echo Done! You can now use VS Code, Antigravity, or any git tool normally.
pause
