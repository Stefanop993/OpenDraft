/**
 * The built-in screenplay commands.
 *
 * These are the semantic actions a model should use instead of pasting text:
 * `script.insertDialogue` knows that a cue comes before the line and that the
 * cue is capitalised, so the model only supplies the character and the words.
 * The editor, not the model, decides formatting.
 *
 * Every string is clamped and every id validated before it reaches the editor:
 * parameters arrive from a model, which is hostile input as far as the script
 * is concerned.
 */
import { registerCommand } from './registry';
import type { BlockSpec, CommandElement } from './types';

const MAX_TEXT = 20_000;
const MAX_NAME = 80;
const MAX_PARENTHETICAL = 200;

const ELEMENTS: readonly CommandElement[] = [
  'sceneHeading', 'action', 'character', 'dialogue', 'parenthetical',
  'transition', 'general', 'shot', 'newAct', 'endOfAct', 'lyrics',
];

/** A non-empty string, newlines flattened to spaces, capped. */
function textArg(args: Record<string, unknown>, key: string, max = MAX_TEXT): string | null {
  const raw = args[key];
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').replace(/\s*\n\s*/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function elementArg(args: Record<string, unknown>, key: string): CommandElement | null {
  const raw = args[key];
  if (typeof raw !== 'string') return null;
  return (ELEMENTS as readonly string[]).includes(raw) ? (raw as CommandElement) : null;
}

/** "(V.O.)", "(v.o.)" and "V.O." all become "(V.O.)". */
function extensionArg(args: Record<string, unknown>): string | null {
  const raw = args.extension;
  if (typeof raw !== 'string') return null;
  const inner = raw.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (!inner) return null;
  return `(${inner.slice(0, 40).toUpperCase()})`;
}

/** "beat" and "(beat)" both become "(beat)". */
function parentheticalArg(args: Record<string, unknown>): string | null {
  const raw = args.parenthetical;
  if (typeof raw !== 'string') return null;
  const inner = raw.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (!inner) return null;
  return `(${inner.slice(0, MAX_PARENTHETICAL)})`;
}

const NO_PARAMS = { type: 'object' as const, properties: {}, additionalProperties: false };

export function registerScreenplayCommands(): void {
  registerCommand({
    id: 'script.insertDialogue',
    label: 'Insert dialogue',
    description:
      'Insert a character cue and a line of dialogue at the caret, correctly formatted. '
      + 'Use this whenever the writer asks for something a character says.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Speaking character name, e.g. "BEN".' },
        text: { type: 'string', description: 'The dialogue exactly as it should read.' },
        parenthetical: { type: 'string', description: 'Optional direction in parentheses, e.g. "whispering".' },
        extension: { type: 'string', description: 'Optional cue extension, e.g. "V.O." or "O.S.".' },
      },
      required: ['character', 'text'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const character = textArg(args, 'character', MAX_NAME);
      const text = textArg(args, 'text');
      if (!character) return { ok: false, message: 'A character name is required.' };
      if (!text) return { ok: false, message: 'The dialogue text is required.' };
      const extension = extensionArg(args);
      const parenthetical = parentheticalArg(args);
      const blocks: BlockSpec[] = [
        { type: 'character', text: character.toUpperCase(), extension: extension ?? undefined },
      ];
      if (parenthetical) blocks.push({ type: 'parenthetical', text: parenthetical });
      blocks.push({ type: 'dialogue', text });
      adapter.insertBlocks(blocks);
      return {
        ok: true,
        message: `Inserted ${character.toUpperCase()}${extension ? ` ${extension}` : ''}'s dialogue.`,
        data: { blocks },
      };
    },
  });

  registerCommand({
    id: 'script.insertAction',
    label: 'Insert action',
    description: 'Insert an action line (what we see happening) at the caret.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The action as it should read.' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const text = textArg(args, 'text');
      if (!text) return { ok: false, message: 'The action text is required.' };
      adapter.insertBlocks([{ type: 'action', text }]);
      return { ok: true, message: 'Inserted the action line.', data: { blocks: [{ type: 'action', text }] } };
    },
  });

  registerCommand({
    id: 'script.insertScene',
    label: 'Insert scene',
    description:
      'Insert a scene heading (capitalised for you) and optionally the first action line, at the caret.',
    parameters: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: 'Scene heading, e.g. "INT. DINER - NIGHT".' },
        action: { type: 'string', description: 'Optional first action line of the scene.' },
      },
      required: ['heading'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const heading = textArg(args, 'heading');
      if (!heading) return { ok: false, message: 'A scene heading is required.' };
      const action = textArg(args, 'action');
      const blocks: BlockSpec[] = [{ type: 'sceneHeading', text: heading.toUpperCase() }];
      if (action) blocks.push({ type: 'action', text: action });
      adapter.insertBlocks(blocks);
      return { ok: true, message: `Inserted the scene ${heading.toUpperCase()}.`, data: { blocks } };
    },
  });

  registerCommand({
    id: 'script.insertTransition',
    label: 'Insert transition',
    description: 'Insert a transition such as "CUT TO:" or "DISSOLVE TO:" at the caret.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The transition, e.g. "CUT TO:".' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const text = textArg(args, 'text', 200);
      if (!text) return { ok: false, message: 'The transition text is required.' };
      adapter.insertBlocks([{ type: 'transition', text: text.toUpperCase() }]);
      return { ok: true, message: `Inserted the transition ${text.toUpperCase()}.` };
    },
  });

  registerCommand({
    id: 'script.insertParenthetical',
    label: 'Insert parenthetical',
    description: 'Insert a parenthetical direction, in parentheses, at the caret.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The direction, without parentheses.' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const text = textArg(args, 'text', MAX_PARENTHETICAL);
      if (!text) return { ok: false, message: 'The direction text is required.' };
      adapter.insertBlocks([{ type: 'parenthetical', text: `(${text.replace(/^\((.*)\)$/, '$1')})` }]);
      return { ok: true, message: 'Inserted the parenthetical.' };
    },
  });

  registerCommand({
    id: 'editor.setElement',
    label: 'Set element type',
    description: 'Change the element type of the paragraph the caret is in.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [...ELEMENTS],
          description: 'The element type to apply.',
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const type = elementArg(args, 'type');
      if (!type) return { ok: false, message: 'A valid element type is required.' };
      adapter.setElement(type);
      return { ok: true, message: `Set the element to ${type}.` };
    },
  });

  registerCommand({
    id: 'editor.replaceSelection',
    label: 'Replace selection',
    description:
      'Replace the selected text with new text, optionally changing its element type. '
      + 'With no selection, inserts at the caret.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The replacement text.' },
        element: { type: 'string', enum: [...ELEMENTS], description: 'Optional element type for the result.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const text = textArg(args, 'text');
      if (!text) return { ok: false, message: 'The replacement text is required.' };
      const element = elementArg(args, 'element');
      adapter.replaceSelection(text, element ?? undefined);
      return { ok: true, message: 'Replaced the selection.' };
    },
  });

  registerCommand({
    id: 'editor.insertText',
    label: 'Insert text',
    description: 'Type plain text at the caret without changing the element type.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to insert.' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: ({ adapter }, args) => {
      const text = textArg(args, 'text');
      if (!text) return { ok: false, message: 'The text is required.' };
      adapter.insertText(text);
      return { ok: true, message: 'Inserted the text.' };
    },
  });

  registerCommand({
    id: 'editor.undo',
    label: 'Undo',
    description: 'Undo the last edit.',
    parameters: NO_PARAMS,
    run: ({ adapter }) => {
      adapter.undo();
      return { ok: true, message: 'Undone.' };
    },
  });

  registerCommand({
    id: 'editor.redo',
    label: 'Redo',
    description: 'Redo the last undone edit.',
    parameters: NO_PARAMS,
    run: ({ adapter }) => {
      adapter.redo();
      return { ok: true, message: 'Redone.' };
    },
  });

  registerCommand({
    id: 'script.getContext',
    label: 'Read script context',
    description:
      'Read the current scene, element, selection, characters and scene list. '
      + 'Use it when you need to know where in the script you are before writing.',
    parameters: NO_PARAMS,
    run: ({ adapter }) => {
      const context = adapter.context();
      return { ok: true, message: 'Read the script context.', data: context };
    },
  });
}
