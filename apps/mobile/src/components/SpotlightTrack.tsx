import React, { type ComponentProps } from "react";
import {
  GestureDetector,
  useNativeGesture,
} from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { PagerGesture } from "../pager-gesture";

const CARD_GAP = 10;
export function spotlightGeometry(screenWidth: number) {
  const cardWidth = Math.min(Math.round(screenWidth * 0.87), 424);
  return {
    cardWidth,
    snapInterval: cardWidth + CARD_GAP,
    sidePadding: Math.max(12, Math.round((screenWidth - cardWidth) / 2)),
  };
}

/** Shared floating card pager for results and project work. */
export function SpotlightTrack({
  snapInterval,
  sidePadding,
  ...props
}: Omit<ComponentProps<typeof Animated.ScrollView>, "horizontal"> & {
  snapInterval: number;
  sidePadding: number;
}) {
  const pagerGesture = useNativeGesture({});
  return (
    <PagerGesture.Provider value={pagerGesture}>
      <GestureDetector gesture={pagerGesture}>
        <Animated.ScrollView
          {...props}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={snapInterval}
          snapToAlignment="start"
          disableIntervalMomentum
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingHorizontal: sidePadding,
            gap: CARD_GAP,
          }}
        />
      </GestureDetector>
    </PagerGesture.Provider>
  );
}
