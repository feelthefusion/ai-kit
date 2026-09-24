/**
 * site-agent · web widget — the customer chat (React, @ai-sdk/react). Structural only: style it with
 * the site's design system, or swap the markup for ai-elements components (Conversation, Message,
 * PromptInput, Confirmation) — the logic below stays the same.
 *
 * • Sends ONLY the newest message + conversation id (server owns history).
 * • Carries the visitor id (visitor-intel) on every request → resume across reloads/devices, context.
 * • Confirm cards: a write action arrives as `approval-requested`; Confirm/Cancel answers it and the
 *   chat continues automatically (lastAssistantMessageIsCompleteWithApprovalResponses).
 * • Live: subscribes to /chat/:id/live so "Address updated ✓" and "A teammate joined" appear instantly.
 */
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { visitorHeaders } from "../../visitor-intel/references/fingerprint";

const API = "/api/v1/ai";

export function SiteChat({ title = "Chat with us", greeting = "Hi! I can track orders, update your subscription or address, and help you find the right product." }: { title?: string; greeting?: string }) {
  const conv = useRef<string | undefined>(typeof window !== "undefined" ? localStorage.getItem("ai.conv") ?? undefined : undefined);
  const [toast, setToast] = useState<string>();
  const [input, setInput] = useState("");

  const { messages, sendMessage, addToolApprovalResponse, status, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: `${API}/chat`,
      credentials: "include",
      headers: async () => visitorHeaders(),
      prepareSendMessagesRequest: ({ messages: all }) => ({ body: { conversationId: conv.current, message: all[all.length - 1] } }),
      fetch: async (url, init) => {
        const r = await fetch(url, init);
        const id = r.headers.get("x-conversation-id");
        if (id && id !== conv.current) { conv.current = id; localStorage.setItem("ai.conv", id); }
        return r;
      },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  // resume the transcript (same device, or another device once visitor-intel stitched the customer)
  useEffect(() => {
    if (!conv.current) return;
    void (async () => {
      const r = await fetch(`${API}/chat/${conv.current}`, { credentials: "include", headers: await visitorHeaders() });
      if (r.ok) setMessages(((await r.json()) as { messages: UIMessage[] }).messages);
      else { localStorage.removeItem("ai.conv"); conv.current = undefined; }
    })();
  }, [setMessages]);

  // live updates for this conversation
  useEffect(() => {
    if (!conv.current) return;
    const es = new EventSource(`${API}/chat/${conv.current}/live`, { withCredentials: true });
    es.addEventListener("ai.action", (e) => { const d = JSON.parse((e as MessageEvent).data); if (d.status === "executed" && d.summary) setToast(`${d.summary} ✓`); });
    es.addEventListener("ai.conversation", (e) => { const d = JSON.parse((e as MessageEvent).data); if (d.status === "handoff") setToast("A teammate is joining the chat."); });
    return () => es.close();
  }, [messages.length > 0]);

  return (
    <section aria-label={title} data-ai-chat>
      <header>{title}</header>
      <ol aria-live="polite">
        {messages.length === 0 && <li data-role="assistant">{greeting}</li>}
        {messages.map((m) => (
          <li key={m.id} data-role={m.role}>
            {m.parts.map((p, i) => {
              if (p.type === "text") return <p key={i}>{p.text}</p>;
              if (isToolUIPart(p) && p.state === "approval-requested") {
                const reason = (p.approval.descriptor as { reason?: string } | undefined)?.reason;
                return (
                  <div key={i} role="group" data-confirm>
                    <p>{reason ?? "Confirm this change?"}</p>
                    <button onClick={() => addToolApprovalResponse({ id: p.approval.id, approved: true })}>Confirm</button>
                    <button onClick={() => addToolApprovalResponse({ id: p.approval.id, approved: false })}>Cancel</button>
                  </div>
                );
              }
              if (isToolUIPart(p) && p.state === "output-available") return <p key={i} data-done>✓ Done</p>;
              return null;
            })}
          </li>
        ))}
      </ol>
      {toast && <output onAnimationEnd={() => setToast(undefined)}>{toast}</output>}
      <form onSubmit={(e) => { e.preventDefault(); if (!input.trim()) return; void sendMessage({ text: input }); setInput(""); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about orders, subscriptions, products…" disabled={status === "streaming"} aria-label="Message" />
        <button type="submit" disabled={status === "streaming" || !input.trim()}>Send</button>
      </form>
    </section>
  );
}
