import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
const COUNTER_OPERATORS = new Set(["<", "<=", ">", ">="]);
const TIMERS = new Set(["setImmediate", "setTimeout"]);
const MESSAGE =
  "Polling loop in a test. Spinning on `yieldNow`/`sleep` is scheduler- and load-dependent. Await the `Deferred`, `Queue.take`, `Stream` element, `drain()`, or `expect.poll` that marks the milestone.";

type LoopNode = ESTree.ForStatement | ESTree.WhileStatement | ESTree.DoWhileStatement;

const isNode = (value: unknown): value is ESTree.Node =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

// Visits `node` and its descendants, skipping nested functions: a wait or exit
// inside a callback runs on the callback's schedule, not the loop's.
const someDescendant = (node: unknown, match: (node: ESTree.Node) => boolean): boolean => {
  if (Array.isArray(node)) return node.some((child) => someDescendant(child, match));
  if (!isNode(node)) return false;
  if (match(node)) return true;
  if (FUNCTIONS.has(node.type)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (someDescendant(value, match)) return true;
  }
  return false;
};

const memberName = (node: unknown): Option.Option<readonly [string, string]> => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }
  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(object) || object.value.type !== "Identifier" || Option.isNone(property)) {
    return Option.none();
  }
  return Option.some([object.value.name, property.value] as const);
};

const isMember = (node: unknown, object: string, property: string): boolean =>
  Option.match(memberName(node), {
    onNone: () => false,
    onSome: ([name, key]) => name === object && key === property,
  });

const isTimerReference = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    Option.isSome(expression) &&
    expression.value.type === "Identifier" &&
    TIMERS.has(expression.value.name)
  );
};

// `Promise.resolve()`, or a `new Promise` whose executor schedules a timer.
const isTickPromise = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return false;
  const value = expression.value;
  if (value.type === "CallExpression") return isMember(value.callee, "Promise", "resolve");
  if (value.type !== "NewExpression" || !isIdentifier(Option.some(value.callee), "Promise")) {
    return false;
  }
  const [executor] = value.arguments;
  if (isTimerReference(executor)) return true;
  if (!isNode(executor) || !FUNCTIONS.has(executor.type)) return false;
  return someDescendant(
    (executor as ESTree.ArrowFunctionExpression).body,
    (child) => child.type === "CallExpression" && isTimerReference(child.callee),
  );
};

const thunkReturnsTick = (node: unknown): boolean => {
  if (!isNode(node) || node.type !== "ArrowFunctionExpression") return false;
  const body = node.body;
  if (body.type !== "BlockStatement") return isTickPromise(body);
  const last = body.body.at(-1);
  return last?.type === "ReturnStatement" && isTickPromise(last.argument);
};

const isWait = (node: ESTree.Node): boolean => {
  if (node.type === "MemberExpression") return isMember(node, "Effect", "yieldNow");
  if (node.type === "AwaitExpression") return isTickPromise(node.argument);
  if (node.type === "NewExpression") return isTickPromise(node);
  if (node.type !== "CallExpression") return false;
  if (isMember(node.callee, "Effect", "sleep")) return true;
  if (isIdentifier(unwrapExpression(node.callee), "setImmediate")) return true;
  if (isMember(node.callee, "Effect", "promise")) return thunkReturnsTick(node.arguments[0]);
  return false;
};

const isFailure = (node: ESTree.Node): boolean =>
  node.type === "ThrowStatement" ||
  (node.type === "CallExpression" &&
    (isMember(node.callee, "Effect", "die") || isMember(node.callee, "Effect", "fail")));

const hasConditionalExit = (body: ESTree.Node): boolean =>
  someDescendant(
    body,
    (node) =>
      node.type === "IfStatement" &&
      someDescendant(
        [node.consequent, node.alternate],
        (child) =>
          child.type === "ReturnStatement" ||
          child.type === "BreakStatement" ||
          child.type === "ThrowStatement",
      ),
  );

// A bare counter (`i < 3`, `attempt < max`) bounds the loop without asking
// anything about the system under test.
const isCounterTest = (test: ESTree.Expression | null | undefined): boolean => {
  if (test == null) return false;
  const expression = unwrapExpression(test);
  if (Option.isNone(expression) || expression.value.type !== "BinaryExpression") return false;
  if (!COUNTER_OPERATORS.has(expression.value.operator)) return false;
  return !someDescendant(expression.value, (node) => node.type === "CallExpression");
};

const isTrueLiteral = (test: ESTree.Expression): boolean => {
  const expression = unwrapExpression(test);
  return (
    Option.isSome(expression) &&
    expression.value.type === "Literal" &&
    expression.value.value === true
  );
};

// `for (...) { yield* Effect.yieldNow } return yield* Effect.die("timed out")`
// keys a failure on the loop running out, which makes the bound a budget.
const failsAfterLoop = (loop: LoopNode): boolean => {
  const parent = loop.parent;
  if (parent?.type !== "BlockStatement" && parent?.type !== "Program") return false;
  const statements: ReadonlyArray<ESTree.Node> = parent.body;
  const next = statements[statements.indexOf(loop) + 1];
  return next !== undefined && someDescendant(next, isFailure);
};

const hasPredicateExit = (loop: LoopNode): boolean => {
  if (hasConditionalExit(loop.body)) return true;
  if (loop.type === "ForStatement") {
    if (loop.test != null && !isCounterTest(loop.test)) return true;
    return failsAfterLoop(loop);
  }
  return !isTrueLiteral(loop.test);
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow loops in tests that spin on yieldNow/sleep/timer ticks until a predicate holds; await the milestone instead.",
    },
    schema: [],
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const check = (loop: LoopNode) => {
      if (!someDescendant(loop.body, isWait)) return;
      if (!hasPredicateExit(loop)) return;
      context.report({ node: loop, message: MESSAGE });
    };

    return {
      ForStatement: check,
      WhileStatement: check,
      DoWhileStatement: check,
    };
  },
});
