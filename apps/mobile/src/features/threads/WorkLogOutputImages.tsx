// The images an expanded work-log row's tool call returned (an OMP eval cell's plots, a
// screenshot), shown above its output and swipeable in one preview gallery.
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { ThreadMarkdownImage } from "./ThreadMarkdownImage";

export function WorkLogOutputImages(props: {
  readonly environmentId: EnvironmentId;
  /** From `turnItemOutputImages` on the row's fetched item. */
  readonly resources: ReadonlyArray<Extract<AssetResource, { readonly _tag: "tool-output-image" }>>;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  return (
    <FilePreviewGallery
      value={props.resources.map((resource) => ({
        kind: "image",
        environmentId: props.environmentId,
        resource,
      }))}
    >
      {props.resources.map((resource) => (
        <View key={resource.index} className="pb-1.5">
          <ThreadMarkdownImage
            environmentId={props.environmentId}
            resource={resource}
            alt={null}
            onPressPreview={props.onPressPreview}
          />
        </View>
      ))}
    </FilePreviewGallery>
  );
}
