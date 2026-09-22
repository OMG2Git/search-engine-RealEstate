// Next.js runs register() once, automatically, the moment the server
// process starts — no matter how `npm run dev` (or a production start) is
// invoked, so nobody has to remember to redirect output to a file by hand.
//
// This file also gets bundled for the Edge runtime (which has no fs/path),
// so the actual logging logic lives in instrumentation-node.ts and is only
// ever imported inside the nodejs branch below. Keeping this file free of
// any direct Node-only import is what avoids Turbopack's "Node.js API used
// in Edge Runtime" warnings on every single route compile — confirmed by
// testing: importing fs/path directly in this file, even behind the same
// runtime check, still triggered that warning repeatedly and flooded the
// log with noise instead of just working quietly.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
