import React, { createContext, useContext, useEffect, useState } from "react";
import { ScrollView, type StyleProp, type ViewStyle } from "react-native";
import {
  GestureDetector,
  usePanGesture,
  type NativeGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useSharedValue,
  withDecay,
} from "react-native-reanimated";

/**
 * The sideways pager (the Done carousel) registers its scroll as a native
 * gesture here. A sideways block inside it (table, code) owns a horizontal
 * pan that blocks the pager, so a swipe that starts on the block scrolls the
 * block and a swipe anywhere else flips the pager. Both are decided on the UI
 * thread by react-native-gesture-handler, so a busy JS thread cannot hand the
 * swipe to the pager first.
 */
export const PagerGesture = createContext<NativeGesture | null>(null);

type SidewaysScrollProps = {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

/** A horizontal scroll area that wins over an enclosing pager. */
export function SidewaysScroll({ style, children }: SidewaysScrollProps) {
  const pager = useContext(PagerGesture);
  if (!pager) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={style}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <PannedScroll style={style} pager={pager}>
      {children}
    </PannedScroll>
  );
}

function PannedScroll({
  style,
  children,
  pager,
}: SidewaysScrollProps & { pager: NativeGesture }) {
  const ref = useAnimatedRef<Animated.ScrollView>();
  const offset = useSharedValue(0);
  const start = useSharedValue(0);
  const max = useSharedValue(0);
  const [viewWidth, setViewWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const overflow = Math.max(0, contentWidth - viewWidth);

  useEffect(() => {
    max.value = overflow;
    if (offset.value > overflow) offset.value = overflow;
  }, [overflow, max, offset]);

  useAnimatedReaction(
    () => offset.value,
    (x) => {
      scrollTo(ref, x, 0, false);
    },
  );

  const pan = usePanGesture({
    // A block that fits needs no swipe of its own; leave it to the pager.
    enabled: overflow > 0,
    activeOffsetX: [-8, 8],
    failOffsetY: [-8, 8],
    block: pager,
    onActivate: () => {
      "worklet";
      cancelAnimation(offset);
      start.value = offset.value;
    },
    onUpdate: (event) => {
      "worklet";
      offset.value = Math.min(
        max.value,
        Math.max(0, start.value - event.translationX),
      );
    },
    onDeactivate: (event) => {
      "worklet";
      offset.value = withDecay({
        velocity: -event.velocityX,
        clamp: [0, max.value],
      });
    },
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.ScrollView
        ref={ref}
        horizontal
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        style={style}
        onLayout={(event) => setViewWidth(event.nativeEvent.layout.width)}
        onContentSizeChange={(width) => setContentWidth(width)}
      >
        {children}
      </Animated.ScrollView>
    </GestureDetector>
  );
}
