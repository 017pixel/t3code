import type { Nodes, Root } from "mdast";

const LIST_ITEM_NUMBER = /[ \t]*(\d{1,9})[.)]/y;

/**
 * CommonMark keeps only an ordered list's first number, so `1.` `5.` `8.` renders
 * as 1, 2, 3. Users type the numbers they mean, so their messages keep each one
 * as the item's `value`.
 */
export function remarkExplicitListNumbers() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: Nodes) => {
      if (node.type === "list" && node.ordered) {
        let displayed = (node.start ?? 1) - 1;
        for (const item of node.children) {
          const offset = item.position?.start.offset;
          if (offset === undefined) break;
          LIST_ITEM_NUMBER.lastIndex = offset;
          const typed = LIST_ITEM_NUMBER.exec(source)?.[1];
          const number = typed === undefined ? displayed + 1 : Number(typed);
          if (number !== displayed + 1) {
            item.data = {
              ...item.data,
              hProperties: { ...item.data?.hProperties, value: String(number) },
            };
          }
          displayed = number;
        }
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}

export const USER_MESSAGE_REMARK_PLUGINS = [remarkExplicitListNumbers];
