import { useThreadFileBindings } from "../features/threads/useThreadFileLinks";
import { decodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextHref,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { markdownWithHtml, markdownWithTableBreaks } from "../lib/markdownDocument";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ActionSheetIOS, Platform, Share, StyleSheet, View } from "react-native";
import {
  EnrichedMarkdownText,
  type DocumentAssetsEvent,
  type MarkdownStyle,
  type MarkdownMediaAsset,
} from "react-native-enriched-markdown";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { Menu } from "../components/ui/Menu";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedSkillLinkRegex,
} from "../lib/enrichedLinkPresentation";

function enrichedStyle(
  style: SelectableMarkdownTextProps["textStyle"],
  dark: boolean,
): MarkdownStyle {
  const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
  // Keep the radius modest: iOS clips square table-cell borders without stroking the corner arcs.
  const block = {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: style.dividerColor,
  };
  const body = {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    marginTop: 0,
    marginBottom: 8,
  };
  const heading = (level: number) => {
    const fontSize = style.headingFontSizes?.[level - 1] ?? style.fontSize * (1.6 - level * 0.1);
    return {
      ...body,
      color: style.strongColor,
      fontFamily: style.headingFontFamily,
      fontSize,
      lineHeight: fontSize * 1.35,
      marginTop: 8,
    };
  };
  return {
    paragraph: body,
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: "normal" },
    link: { color: style.linkColor, underline: false },
    code: {
      fontFamily: monospace,
      color: style.inlineCodeColor,
      backgroundColor: "transparent",
      borderColor: "transparent",
      fontSize: style.fontSize * 0.9,
    },
    codeBlock: {
      ...body,
      color: style.codeColor,
      backgroundColor: style.codeBlockBackgroundColor,
      fontFamily: monospace,
      fontSize: style.fontSize * 0.9,
      ...block,
      padding: 12,
      syntaxColors: dark
        ? {
            keyword: "#ff7b72",
            string: "#a5d6ff",
            number: "#79c0ff",
            constant: "#79c0ff",
            comment: "#8b949e",
            function: "#d2a8ff",
            type: "#ffa657",
            property: "#79c0ff",
            tag: "#7ee787",
            attribute: "#79c0ff",
          }
        : {
            keyword: "#cf222e",
            string: "#0a3069",
            number: "#0550ae",
            constant: "#0550ae",
            comment: "#6e7781",
            function: "#8250df",
            type: "#953800",
            property: "#0550ae",
            tag: "#116329",
            attribute: "#0550ae",
          },
    },
    blockquote: {
      ...body,
      color: style.mutedColor,
      backgroundColor: "transparent",
      borderColor: style.quoteMarkerColor,
      borderWidth: 2,
      gapWidth: 12,
    },
    list: { ...body, bulletColor: style.mutedColor, markerColor: style.mutedColor, gapWidth: 6 },
    thematicBreak: { color: style.dividerColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      ...body,
      ...block,
      headerFontFamily: style.boldFontFamily,
      headerTextColor: style.strongColor,
      headerBackgroundColor: style.codeBlockBackgroundColor,
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 7,
    },
    taskList: {
      checkedColor: style.linkColor,
      checkedTextColor: style.color,
      borderColor: style.mutedColor,
      checkedStrikethrough: false,
    },
  };
}

export function MobileEnrichedMarkdownText(props: SelectableMarkdownTextProps) {
  const { renderImage, resolveImageSource } = props;
  const markdown = useMemo(
    () => markdownWithTableBreaks(markdownWithHtml(props.markdown)),
    [props.markdown],
  );
  const { themeAppearance } = useAppearancePreferences();
  const [documentAssets, setDocumentAssets] = useState<DocumentAssetsEvent["assets"]>([]);
  const onDocumentAssets = useCallback(({ assets }: DocumentAssetsEvent) => {
    setDocumentAssets((previous) =>
      previous.length === assets.length &&
      previous.every((asset, index) => {
        const next = assets[index]!;
        return (
          asset.id === next.id &&
          asset.kind === next.kind &&
          asset.url === next.url &&
          asset.altText === next.altText &&
          asset.title === next.title &&
          asset.placement === next.placement &&
          asset.eligible === next.eligible
        );
      })
        ? previous
        : assets,
    );
  }, []);
  const fileBindings = useThreadFileBindings(documentAssets);
  const { linkVariants, linkPillContent } = useEnrichedLinkVariants(documentAssets, {
    ...props,
    linkCustomization: (url) =>
      fileBindings.unverifiedRootless(url) ? { plain: true } : props.linkCustomization?.(url),
  });
  const linkRecognition = useMemo(
    () => ({
      text: enrichedSkillLinkRegex(props.skills) ?? undefined,
      inlineCode: ENRICHED_INLINE_FILE_LINK_REGEX,
    }),
    [props.skills],
  );
  const [activeMenu, setActiveMenu] = useState<{
    url: string;
    isCurrent: () => boolean;
    menu: NonNullable<ReturnType<NonNullable<typeof props.fileContextMenu>>>;
  } | null>(null);
  const { fileContextMenu, onLinkPress, onFileContextMenuAction } = props;
  const performMenuAction = useCallback(
    (url: string, actionId: string) => {
      if (actionId === "enriched-open-link") onLinkPress?.(url);
      else if (actionId === "enriched-copy-link") copyTextWithHaptic(url);
      else if (actionId === "enriched-share-link") void Share.share({ message: url });
      else onFileContextMenuAction?.(url, actionId);
    },
    [onLinkPress, onFileContextMenuAction],
  );
  const selectionClipboard = useMemo(() => {
    const fragment = decodeComposerContextFragment(props.contextClipboardFragment);
    if (!fragment) return undefined;
    const references = collectComposerContextReferences(props.markdown);
    const linkTextByUrl = Object.fromEntries(
      references.flatMap((reference) => {
        const record = fragment.records.find((entry) => entry.contextId === reference.contextId);
        return record
          ? [
              [
                formatComposerContextHref(reference.kind, reference.contextId),
                formatComposerContextReference({ ...reference, label: record.label }),
              ],
            ]
          : [];
      }),
    );
    return {
      linkTextByUrl,
      htmlAttributes: {
        "data-t3-context-fragment": encodeURIComponent(props.contextClipboardFragment!),
      },
      mimeTypes: { "app.t3.context-fragment": props.contextClipboardFragment! },
    };
  }, [props.contextClipboardFragment, props.markdown]);
  const markdownStyle = useMemo(
    () => ({ ...enrichedStyle(props.textStyle, themeAppearance === "dark"), linkVariants }),
    [props.textStyle, themeAppearance, linkVariants],
  );
  const { href: fileHref, capture: captureImage } = fileBindings;
  const renderMedia = useCallback(
    (asset: MarkdownMediaAsset) =>
      renderImage?.({
        href: fileHref(asset.url),
        alt: asset.altText || null,
        title: asset.title || null,
      }) ?? null,
    [renderImage, fileHref],
  );
  const resolveNativeImageSource = useCallback(
    async (asset: MarkdownMediaAsset) => {
      const isCurrent = captureImage();
      const source = await resolveImageSource?.({
        href: fileHref(asset.url),
        alt: asset.altText || null,
        title: asset.title || null,
      });
      if (!isCurrent()) throw new Error("Markdown image request is obsolete");
      return source ?? null;
    },
    [resolveImageSource, fileHref, captureImage],
  );
  const renderMarkdown = (openAndroidMenu?: () => void) => {
    const onLinkLongPress =
      (Platform.OS === "ios" && (fileContextMenu || onLinkPress)) ||
      (Platform.OS === "android" && fileContextMenu)
        ? ({ url }: { url: string }) => {
            const shown = fileBindings.href(url);
            const menu = (fileBindings.unverifiedRootless(url)
              ? { title: url, actions: [{ id: "enriched-copy-link", title: "Copy link" }] }
              : fileContextMenu?.(shown)) ?? {
              title: url,
              actions: [
                { id: "enriched-open-link", title: "Open link" },
                { id: "enriched-copy-link", title: "Copy link" },
                ...(Platform.OS === "ios"
                  ? [{ id: "enriched-share-link", title: "Share link" }]
                  : []),
              ],
            };
            const isCurrent = fileBindings.captureOwner();
            if (Platform.OS === "ios") {
              // The fork's custom menu dispatches against its latest table and exposes
              // no opening event. An action sheet retains this opening's exact callback.
              ActionSheetIOS.showActionSheetWithOptions(
                {
                  title: menu.title,
                  options: [...menu.actions.map((action) => action.title), "Cancel"],
                  cancelButtonIndex: menu.actions.length,
                  disabledButtonIndices: menu.actions.flatMap((action, index) =>
                    "disabled" in action && action.disabled ? [index] : [],
                  ),
                  userInterfaceStyle: themeAppearance,
                },
                (index) => {
                  const action = menu.actions[index];
                  if (isCurrent() && action && !("disabled" in action && action.disabled))
                    performMenuAction(shown, action.id);
                },
              );
            } else {
              setActiveMenu({ url: shown, menu, isCurrent });
              openAndroidMenu?.();
            }
          }
        : undefined;

    return (
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          marginTop: props.marginTop,
          marginBottom: props.marginBottom,
        }}
      >
        <EnrichedMarkdownText
          markdown={markdown}
          markdownStyle={markdownStyle}
          onDocumentAssets={onDocumentAssets}
          renderMedia={renderImage ? renderMedia : undefined}
          resolveImageSource={resolveImageSource ? resolveNativeImageSource : undefined}
          onImagePress={
            props.onImagePress || props.onLinkPress
              ? ({ url }) => {
                  if (!fileBindings.unverifiedRootless(url))
                    (props.onImagePress ?? props.onLinkPress)?.(fileBindings.href(url));
                }
              : undefined
          }
          linkRecognition={linkRecognition}
          containerStyle={{ flexShrink: 1, minWidth: 0 }}
          flavor="github"
          selectable
          selectionClipboard={selectionClipboard}
          selectionColor={props.textStyle.selectionColor}
          selectionHandleColor={props.textStyle.selectionHandleColor}
          md4cFlags={{
            latexMath: false,
            hardSoftBreaks: props.preserveSoftBreaks ?? false,
            admonitions: true,
          }}
          enableTaskListItemToggle={false}
          enableCodeBlockWrapToggle
          spoilerOverlay="solid"
          onLinkPress={
            props.onLinkPress
              ? ({ url }) => {
                  if (!fileBindings.unverifiedRootless(url))
                    props.onLinkPress?.(fileBindings.href(url));
                }
              : undefined
          }
          onLinkLongPress={onLinkLongPress}
          linkPillContent={linkPillContent}
        />
      </View>
    );
  };

  return Platform.OS === "android" && props.fileContextMenu ? (
    <Menu
      shouldOpenOnLongPress
      title={activeMenu?.menu.title}
      actions={
        activeMenu?.menu.actions.map((action) => ({
          id: action.id,
          title: action.title,
          attributes: { disabled: action.disabled },
        })) ?? []
      }
      onPressAction={({ nativeEvent }) => {
        if (activeMenu?.isCurrent()) performMenuAction(activeMenu.url, nativeEvent.event);
      }}
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      <MarkdownMenuAnchor renderMarkdown={renderMarkdown} />
    </Menu>
  ) : (
    renderMarkdown()
  );
}

/** Adapts the rich-text link gesture to Menu's long-press trigger without wrapping text in a Pressable. */
function MarkdownMenuAnchor(props: {
  readonly renderMarkdown: (openMenu?: () => void) => ReactNode;
  readonly onLongPress?: () => void;
}) {
  return props.renderMarkdown(props.onLongPress);
}
