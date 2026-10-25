import { AccessibilityInfo, Platform } from "react-native";

const announced = new WeakSet<object>();

/**
 * Ref callback that announces `message` once per mounted node. Pair it with
 * `key={message}` so a new message mounts a new node. Live regions reach
 * TalkBack; VoiceOver needs an explicit announcement.
 */
export function announceRef(message: string) {
  return (node: object | null) => {
    if (node === null || announced.has(node)) return;
    announced.add(node);
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(message);
  };
}
