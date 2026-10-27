import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useOmpThreadInstanceId } from "./omp-thread";
import {
  OMP_THREAD_VIEW_TITLES,
  OmpBranchTreePanel,
  OmpShareGistPanel,
  OmpShareLivePanel,
  OmpThreadMenu,
  type OmpThreadView,
} from "./OmpThreadMenu";
import { ThreadGoalPanel } from "./ThreadGoalPanel";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type OmpSheetTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** A form sheet with a native header on iOS and the sheet header on Android. */
function OmpSheetFrame(props: {
  readonly title: string;
  readonly screenId: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      // UIKit must inset content beneath the floating translucent iOS header.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {props.children}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    // Plain formSheets lack stack headers; host one in a nested native stack.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId={props.screenId}
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title={props.title}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title={props.title} onBack={props.onBack} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function NotOmpThread() {
  return (
    <Text className="pt-6 text-center text-sm text-foreground-muted">
      This thread does not run on OMP.
    </Text>
  );
}

/** The OMP section of an OMP thread: the menu, and the view a picked item opens. */
export function ThreadOmpSheet({ route }: StaticScreenProps<OmpSheetTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const instanceId = useOmpThreadInstanceId(target);
  const [view, setView] = useState<OmpThreadView>("menu");
  const backToMenu = () => setView("menu");
  const panelProps =
    instanceId === null ? null : ({ ...target, instanceId, onDone: backToMenu } as const);
  return (
    <OmpSheetFrame
      title={OMP_THREAD_VIEW_TITLES[view]}
      screenId="thread-omp-sheet-native"
      onBack={() => (view === "menu" ? navigation.goBack() : backToMenu())}
    >
      {panelProps === null ? (
        <NotOmpThread />
      ) : view === "share-gist" ? (
        <OmpShareGistPanel {...panelProps} />
      ) : view === "share-live" ? (
        <OmpShareLivePanel {...panelProps} />
      ) : view === "branch-tree" ? (
        <OmpBranchTreePanel {...panelProps} />
      ) : (
        <OmpThreadMenu
          {...target}
          instanceId={panelProps.instanceId}
          onOpenView={setView}
          // The goal sheet replaces this leaf sheet, as other sheet-to-sheet moves do.
          onOpenGoal={() => navigation.dispatch(StackActions.replace("ThreadGoal", target))}
        />
      )}
    </OmpSheetFrame>
  );
}

/** An OMP thread's goal: its summary and actions, or a form to set one. */
export function ThreadGoalSheet({ route }: StaticScreenProps<OmpSheetTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const instanceId = useOmpThreadInstanceId(target);
  return (
    <OmpSheetFrame
      title="Goal"
      screenId="thread-goal-sheet-native"
      onBack={() => navigation.goBack()}
    >
      {instanceId === null ? (
        <NotOmpThread />
      ) : (
        <ThreadGoalPanel environmentId={target.environmentId} threadId={target.threadId} />
      )}
    </OmpSheetFrame>
  );
}
