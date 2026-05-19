"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ConversationWithLastMessage, Message } from "@/lib/types";

interface Props {
  conversation: ConversationWithLastMessage;
  messages: Message[];
  onSendMessage: (text: string) => Promise<void>;
  isSending: boolean;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInitials(name: string | null, username: string | null): string {
  const str = name || username || "?";
  return str
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function ChatPanel({ conversation, messages, onSendMessage, isSending }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    await onSendMessage(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 text-sm mt-8">
            No messages yet
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === "user";
          return (
            <div
              key={msg.id}
              className={`flex items-end gap-3 ${isUser ? "justify-start" : "justify-end"}`}
            >
              {/* User avatar (left side) */}
              {isUser && (
                <div className="flex-shrink-0 mb-1">
                  {conversation.profile_pic ? (
                    <Image
                      src={conversation.profile_pic}
                      alt={conversation.name ?? "User"}
                      width={32}
                      height={32}
                      className="rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-xs font-bold">
                      {getInitials(conversation.name, conversation.username)}
                    </div>
                  )}
                </div>
              )}

              <div className={`max-w-xs lg:max-w-md xl:max-w-lg ${isUser ? "" : "items-end flex flex-col"}`}>
                <div
                  className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    isUser
                      ? "bg-gray-700 text-white rounded-bl-sm"
                      : "bg-gradient-to-r from-purple-600 to-red-500 text-white rounded-br-sm"
                  }`}
                >
                  {msg.content}
                </div>
                <div className="flex items-center gap-1 mt-1 px-1">
                  {!isUser && (
                    <span className="text-purple-400 text-xs">AI ·</span>
                  )}
                  <span className="text-gray-500 text-xs">{formatTime(msg.created_at)}</span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 p-4 bg-gray-900">
        {conversation.mode === "human" && (
          <p className="text-amber-400 text-xs mb-2 flex items-center gap-1">
            <span>👤</span>
            Human mode — AI auto-reply is disabled
          </p>
        )}
        <div className="flex items-end gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-gray-800 text-white placeholder-gray-500 rounded-xl px-4 py-3 text-sm resize-none outline-none focus:ring-1 focus:ring-purple-500 max-h-32"
            style={{ minHeight: "44px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 text-white px-5 py-3 rounded-xl text-sm font-medium transition-all flex-shrink-0"
          >
            {isSending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
