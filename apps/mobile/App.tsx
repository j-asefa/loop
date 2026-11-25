import React, { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FeedScreen } from "./src/components/FeedScreen";
import { SpotlightCarousel } from "./src/components/SpotlightCarousel";
import {
  buildSimulatedReply,
  createInitialCards,
  type FeedTab,
  type NativeResultCard,
} from "./src/fixtures";
import { haptics } from "./src/haptics";
import { DARK_THEME, LIGHT_THEME } from "./src/theme";

export default function App() {
  const [darkMode, setDarkMode] = useState(true);
  const theme = darkMode ? DARK_THEME : LIGHT_THEME;

  const [cards, setCards] = useState<NativeResultCard[]>(() =>
    createInitialCards(),
  );
  const [activeTab, setActiveTab] = useState<FeedTab>("done");
  const [openConversationId, setOpenConversationId] = useState<string | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const openCards = useMemo(() => {
    if (!openConversationId) return [];
    return cards.filter(
      (c) =>
        c.conversationId === openConversationId &&
        (c.tab === "done" || c.tab === activeTab),
    );
  }, [cards, openConversationId, activeTab]);

  const handleMarkRead = useCallback((cardId: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, unread: false } : c)),
    );
  }, []);

  const handleToggleSaved = useCallback(
    (cardId: string) => {
      setCards((prev) =>
        prev.map((c) => {
          if (c.id !== cardId) return c;
          const nextSaved = !c.saved;
          showToast(nextSaved ? "Saved card" : "Removed from Saved");
          return { ...c, saved: nextSaved };
        }),
      );
    },
    [showToast],
  );

  const handleSwipeDone = useCallback(
    (card: NativeResultCard) => {
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      showToast(`Marked @${card.agentName} card done`);
    },
    [showToast],
  );

  const handleDismissCard = useCallback(
    (cardId: string) => {
      setCards((prev) => prev.filter((c) => c.id !== cardId));
      showToast("Marked done");
    },
    [showToast],
  );

  const handleRemind = useCallback(
    (card: NativeResultCard) => {
      showToast(`Reminder set for @${card.agentName} card`);
    },
    [showToast],
  );

  const handleSendReply = useCallback(
    (
      conversationId: string,
      agentName: string,
      projectName: string,
      model: string,
      prompt: string,
    ) => {
      setTimeout(() => {
        const nextCard = buildSimulatedReply(
          conversationId,
          agentName,
          projectName,
          model,
          prompt,
        );
        setCards((prev) => [nextCard, ...prev]);
        haptics.success();
      }, 1100);
    },
    [],
  );

  const handleResetDemo = useCallback(() => {
    setOpenConversationId(null);
    setCards(createInitialCards());
    setActiveTab("done");
    showToast("Sample deck restored");
  }, [showToast]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style={darkMode ? "light" : "dark"} />
        <View style={[styles.root, { backgroundColor: theme.bg }]}>
          <FeedScreen
            cards={cards}
            activeTab={activeTab}
            theme={theme}
            onSelectTab={setActiveTab}
            onToggleTheme={() => setDarkMode((v) => !v)}
            onResetDemo={handleResetDemo}
            onOpenStack={(conversationId) =>
              setOpenConversationId(conversationId)
            }
            onSwipeDone={handleSwipeDone}
            onSwipeSave={(card) => handleToggleSaved(card.id)}
          />

          {openConversationId && openCards.length > 0 && (
            <SpotlightCarousel
              key={openConversationId}
              cards={openCards}
              theme={theme}
              onClose={() => setOpenConversationId(null)}
              onMarkRead={handleMarkRead}
              onToggleSaved={handleToggleSaved}
              onRemind={handleRemind}
              onDismissCard={handleDismissCard}
              onSendReply={handleSendReply}
            />
          )}

          {toast && (
            <View pointerEvents="none" style={styles.toastWrap}>
              <View
                style={[
                  styles.toastPill,
                  {
                    backgroundColor: theme.raised,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <Text style={[styles.toastText, { color: theme.text }]}>
                  {toast}
                </Text>
              </View>
            </View>
          )}
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  toastWrap: {
    position: "absolute",
    bottom: 92,
    left: 20,
    right: 20,
    alignItems: "center",
    zIndex: 60,
  },
  toastPill: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  toastText: {
    fontSize: 13,
    fontWeight: "600",
  },
});
