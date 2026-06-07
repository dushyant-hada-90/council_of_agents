import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth/token";

const protectedPaths = ["/dashboard", "/agents", "/meetings/new"];
const protectedExactPaths = ["/meetings"];

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  const path = request.nextUrl.pathname;

  const isProtected =
    protectedPaths.some((p) => path === p || path.startsWith(`${p}/`)) ||
    protectedExactPaths.some((p) => path === p);

  const isAuthPage = path === "/login" || path === "/signup";

  if (isProtected && !session) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  if (isAuthPage && session) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
