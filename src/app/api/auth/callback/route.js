import { NextResponse } from 'next/server';
import { signToken } from '@/lib/token';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');

  const host = request.headers.get('host') || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const baseUrl = `${protocol}://${host}`;

  if (!code) {
    return NextResponse.redirect(`${baseUrl}/?error=no_code_provided`);
  }

  try {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const data = await res.json();

    if (data.error) {
      return NextResponse.redirect(`${baseUrl}/?error=${data.error_description || 'oauth_error'}`);
    }

    const accessToken = data.access_token;
    
    // Fetch basic user profile to store username/avatar
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Folder2GitHub',
      },
    });

    let user = { login: 'GitHub User', avatar_url: '' };
    if (userRes.ok) {
      user = await userRes.json();
    }

    const jwtToken = signToken({
      accessToken,
      username: user.login,
      avatarUrl: user.avatar_url,
    });

    const response = NextResponse.redirect(`${baseUrl}/`);
    
    // Set cookie
    response.cookies.set('gh_session', jwtToken, {
      httpOnly: true,
      secure: !host.includes('localhost'),
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 1 week
    });

    return response;
  } catch (error) {
    console.error('Callback error:', error);
    return NextResponse.redirect(`${baseUrl}/?error=server_error`);
  }
}
