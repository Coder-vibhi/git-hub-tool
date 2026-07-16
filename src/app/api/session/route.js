import { NextResponse } from 'next/server';
import { verifyToken } from '@/lib/token';

export async function GET(request) {
  const sessionCookie = request.cookies.get('gh_session');

  if (!sessionCookie) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const payload = verifyToken(sessionCookie.value);
  if (!payload) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({
    authenticated: true,
    username: payload.username,
    avatarUrl: payload.avatarUrl,
    token: payload.accessToken, // send back token safely for API requests run in browser
  });
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete('gh_session');
  return response;
}
