import { NextResponse } from 'next/server';

export async function GET(request) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const host = request.headers.get('host') || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/callback`;
  const scope = 'repo';
  
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=folder2github`;
  
  return NextResponse.redirect(githubAuthUrl);
}
