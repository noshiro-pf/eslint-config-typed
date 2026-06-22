import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESLint,
} from '@typescript-eslint/utils';
import * as ts from 'typescript';

type Options = readonly [];

type MessageIds = 'unnecessaryCoalesceUndefined';

/**
 * Returns `true` if the given type can be `null` (i.e. it is `null`, a union
 * that contains `null`, or a permissive type such as `any` / `unknown`).
 *
 * `any` and `unknown` are treated as nullable so that the rule stays
 * conservative and never removes a `?? undefined` whose left-hand side might be
 * `null` at runtime. A type parameter is reduced to its constraint, and an
 * unconstrained type parameter is treated as nullable because it can be
 * instantiated with `null`.
 */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
const typeIncludesNull = (type: ts.Type): boolean => {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return true;
  }

  if (type.isUnion()) {
    return type.types.some(typeIncludesNull);
  }

  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = type.getConstraint();

    // An unconstrained type parameter (or one whose constraint itself permits
    // `null`) could be instantiated with `null`, so treat it as nullable.
    return constraint === undefined || typeIncludesNull(constraint);
  }

  return (type.flags & ts.TypeFlags.Null) !== 0;
};

/**
 * Returns `true` if the given type is the `undefined` type. Used to confirm
 * that the right-hand side of `?? undefined` is really the `undefined` value
 * and not a shadowed binding (e.g. `const undefined = 123`).
 */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
const isUndefinedType = (type: ts.Type): boolean =>
  !type.isUnion() && (type.flags & ts.TypeFlags.Undefined) !== 0;

export const noUnnecessaryCoalesceUndefined: TSESLint.RuleModule<
  MessageIds,
  Options
> = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require the left-hand side of `?? undefined` to include `null` in its type, and remove the redundant `?? undefined` otherwise',
    },
    fixable: 'code',
    schema: [],
    messages: {
      unnecessaryCoalesceUndefined:
        '`?? undefined` is unnecessary because the left-hand side type does not include `null`. Remove it.',
    },
  },

  create: (context) => {
    const parserServices = ESLintUtils.getParserServices(context);

    const checker = parserServices.program.getTypeChecker();

    return {
      LogicalExpression: (node) => {
        if (node.operator !== '??') return;

        // Only target the literal `?? undefined` syntax.
        if (
          node.right.type !== AST_NODE_TYPES.Identifier ||
          node.right.name !== 'undefined'
        ) {
          return;
        }

        // Confirm the right-hand side really is the `undefined` value and not a
        // shadowed binding (e.g. `const undefined = 123`), in which case
        // `x ?? undefined` is not equivalent to `x`.
        const rightTsNode = parserServices.esTreeNodeToTSNodeMap.get(
          node.right,
        );

        if (!isUndefinedType(checker.getTypeAtLocation(rightTsNode))) return;

        const leftTsNode = parserServices.esTreeNodeToTSNodeMap.get(node.left);

        const leftType = checker.getTypeAtLocation(leftTsNode);

        // The `?? undefined` is meaningful only when the left-hand side can be
        // `null` (it normalizes `null` to `undefined`). If `null` is not part
        // of the type, the operator is a no-op and should be removed.
        if (typeIncludesNull(leftType)) return;

        context.report({
          node,
          messageId: 'unnecessaryCoalesceUndefined',
          fix: (fixer) =>
            fixer.replaceText(node, context.sourceCode.getText(node.left)),
        });
      },
    };
  },
  defaultOptions: [],
} as const;
