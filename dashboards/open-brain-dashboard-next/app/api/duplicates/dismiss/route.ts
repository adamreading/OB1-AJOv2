import { NextRequest, NextResponse } from "next/server";
import { dismissDuplicate } from "@/lib/api";
import { requireSession, AuthError } from "@/lib/auth";

export async function POST(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const body = await request.json().catch(() => ({}));
  const a = Number(body.a);
  const b = Number(body.b);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
    return NextResponse.json(
      { error: "Provide two distinct serial_ids: { a, b }" },
      { status: 400 }
    );
  }

  try {
    const data = await dismissDuplicate(apiKey, a, b, body.reason);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
