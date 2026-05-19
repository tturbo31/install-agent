"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { ConversationWithLastMessage, Message } from "@/lib/types";
import ConversationSidebar from "@/components/ConversationSidebar";
import ChatHeader from "@/components/ChatHeader";
import ChatPanel from "@/components/ChatPanel";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Dashboard() {
  const [conversations, setConversations] = useState<ConversationWithLastMessage[]>([]);
  const [selectedConv, setSelectedConv] = useState<ConversationWithLastMessage | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isTogglingMode, setIsTogglingMode] = useState(false);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setConversations(data);
  }, []);

  const loadMessages = useCallback(async (convId: string) => {
    const res = await fetch(`/api/conversations/${convId}/messages`);
    const data = await res.json();
    setMessages(data);
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (selectedConv) {
      loadMessages(selectedConv.id);
    }
  }, [selectedConv, loadMessages]);

  // Supabase Realtime subscriptions
  useEffect(() => {
    const channel = supabase
      .channel("realtime-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "instagram_messages" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const newMsg = payload.new as Message;
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
            loadConversations();
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "instagram_conversations" },
        () => {
          loadConversations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadConversations]);

  async function handleSelectConversation(conv: ConversationWithLastMessage) {
    setSelectedConv(conv);
    setMessages([]);
  }

  async function handleToggleMode() {
    if (!selectedConv) return;
    setIsTogglingMode(true);
    const newMode = selectedConv.mode === "agent" ? "human" : "agent";
    const res = await fetch(`/api/conversations/${selectedConv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode }),
    });
    if (res.ok) {
      const updated = await res.json();
      setSelectedConv(updated);
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? { ...c, mode: updated.mode } : c))
      );
    }
    setIsTogglingMode(false);
  }

  async function handleSendMessage(text: string) {
    if (!selectedConv) return;
    setIsSending(true);
    await fetch(`/api/conversations/${selectedConv.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setIsSending(false);
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      <ConversationSidebar
        conversations={conversations}
        selectedId={selectedConv?.id ?? null}
        onSelect={handleSelectConversation}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {selectedConv ? (
          <>
            <ChatHeader
              conversation={selectedConv}
              onToggleMode={handleToggleMode}
              isTogglingMode={isTogglingMode}
            />
            <ChatPanel
              conversation={selectedConv}
              messages={messages}
              onSendMessage={handleSendMessage}
              isSending={isSending}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-6xl mb-4">💬</div>
              <h2 className="text-gray-400 text-xl font-medium">Select a conversation</h2>
              <p className="text-gray-600 text-sm mt-2">
                Choose a conversation from the sidebar to start chatting
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
