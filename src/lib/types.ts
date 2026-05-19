export interface InstagramProfile {
  name: string | null;
  username: string | null;
  profile_pic: string | null;
  follower_count: number | null;
  is_user_follow_business: boolean | null;
  is_business_follow_user: boolean | null;
}

export interface Conversation {
  id: string;
  igsid: string;
  name: string | null;
  username: string | null;
  profile_pic: string | null;
  follower_count: number | null;
  is_user_follow_business: boolean | null;
  is_business_follow_user: boolean | null;
  mode: "agent" | "human";
  updated_at: string;
  created_at: string;
}

export interface ConversationWithLastMessage extends Conversation {
  last_message: string | null;
  last_message_at: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  instagram_msg_id: string | null;
  created_at: string;
}

export interface WebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    messaging: Array<{
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message: {
        mid: string;
        text?: string;
        is_echo?: boolean;
        attachments?: Array<{
          type: string;
          payload: { url?: string };
        }>;
      };
      referral?: {
        ref?: string;
        source?: string;
        type?: string;
        ad_id?: string;
        ads_context_data?: {
          ad_title?: string;
          photo_url?: string;
          video_url?: string;
          post_id?: string;
        };
      };
    }>;
  }>;
}
