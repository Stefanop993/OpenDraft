"""
Minimal OpenAI-compatible chat server for testing OpenDraft AI add-ons
without a real model. Answers POST /v1/chat/completions with a fixed line
that echoes the last user message, and logs every request it receives.

Usage:  venv/bin/python test-script/mock_ai_server.py [port]   (default 11435)
Then set the add-on's server address to http://localhost:<port>/v1
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            messages = body.get("messages", [])
            last = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
            print(f"[mock-ai] model={body.get('model')} auth={'yes' if self.headers.get('Authorization') else 'no'} "
                  f"user={last[:120]!r}", flush=True)
            reply = "Rain hammers the window as SARAH reads the letter again."
            payload = json.dumps({"choices": [{"message": {"role": "assistant", "content": reply}}]}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as err:  # report rather than crash the test server
            print(f"[mock-ai] error: {err}", flush=True)
            self.send_response(500)
            self._cors()
            self.end_headers()
            self.wfile.write(str(err).encode())

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11435
    print(f"[mock-ai] listening on http://localhost:{port}/v1", flush=True)
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
