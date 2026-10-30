/**
 * The deterministic path for a scene change:
 *
 *   "ora siamo fuori casa, poco dopo. Vilgax sta cacando"
 *   "interno casa giorno, Ben entra arrabbiato"
 *   "We are outside the house, a little later. Vilgax waits."
 *
 * A small local model reads that as a transition (or misses it). The rule is
 * simple enough to apply here: a new place or time is a scene heading, and the
 * sentence after it is action. Anything ambiguous returns null and goes to the
 * model with the preview.
 */

export interface QuickScene {
  heading: string;
  action?: string;
}

const TIME_WORDS: Record<string, string> = {
  'giorno': 'DAY',
  'di giorno': 'DAY',
  'notte': 'NIGHT',
  'di notte': 'NIGHT',
  'mattina': 'MORNING',
  'la mattina': 'MORNING',
  'sera': 'EVENING',
  'la sera': 'EVENING',
  'pomeriggio': 'AFTERNOON',
  'alba': "DAWN",
  "all'alba": 'DAWN',
  "all’alba": 'DAWN',
  'tramonto': 'DUSK',
  'al tramonto': 'DUSK',
  'poco dopo': 'LATER',
  'più tardi': 'LATER',
  'il giorno dopo': 'NEXT DAY',
  'day': 'DAY',
  'night': 'NIGHT',
  'morning': 'MORNING',
  'evening': 'EVENING',
  'afternoon': 'AFTERNOON',
  'dawn': 'DAWN',
  'dusk': 'DUSK',
  'later': 'LATER',
  'a little later': 'LATER',
  'the next day': 'NEXT DAY',
};

function timeWord(raw: string | undefined): string | null {
  if (!raw) return null;
  return TIME_WORDS[raw.trim().toLowerCase()] ?? raw.trim().toUpperCase();
}

/** "fuori"/"esterno"/"outside" -> EXT.; "dentro"/"interno"/"inside" -> INT. */
function prefixFor(direction: string): 'INT.' | 'EXT.' {
  return /fuori|esterno|outside|ext/i.test(direction) ? 'EXT.' : 'INT.';
}

/** Split the first sentence from the rest, keeping the rest intact. */
function splitFirstSentence(text: string): { clause: string; rest: string } {
  const at = text.search(/[.!]\s+/);
  if (at < 0) return { clause: text.trim(), rest: '' };
  return {
    clause: text.slice(0, at).trim(),
    rest: text.slice(at + 1).trim(),
  };
}

const MOVE_IT = /^(?:ora\s+)?(?:siamo|ci\s+troviamo|andiamo)\s+(fuori|dentro|all['’]?esterno|all['’]?interno)\s+(?:a\s+|in\s+|nel\s+|nella\s+|da\s+)?([\s\S]+)$/iu;
const MOVE_EN = /^(?:now\s+)?(?:we\s+are|we're)\s+(outside|inside)\s+(?:the\s+)?([\s\S]+)$/i;
const HEADING_IT = /^(interno|esterno|int\.?|ext\.?|fuori|dentro)\s+([\p{L}][\p{L}'’ -]{1,40}?)\s*(?:-\s*|,\s*|\s+)(giorno|di giorno|notte|di notte|mattina|la mattina|sera|la sera|pomeriggio|alba|all['’]?alba|tramonto|al tramonto|day|night|morning|evening|afternoon|dawn|dusk)\s*[.,]\s*([\s\S]*)$/iu;

export function parseQuickScene(prompt: string): QuickScene | null {
  const input = prompt.trim();
  if (!input || input.length > 600) return null;

  // "ora siamo fuori casa, poco dopo. <action>"
  const move = input.match(MOVE_IT) ?? input.match(MOVE_EN);
  if (move) {
    const direction = move[1];
    const tail = move[2].trim();
    const { clause, rest } = splitFirstSentence(tail);
    const comma = clause.indexOf(',');
    let place = comma >= 0 ? clause.slice(0, comma).trim() : clause;
    let time = comma >= 0 ? clause.slice(comma + 1).trim() : '';

    if (!time) {
      // "fuori casa poco dopo" without a comma.
      const suffix = place.match(/(poco dopo|più tardi|il giorno dopo|di notte|di giorno|all['’]?alba|al tramonto|la sera|la mattina)\s*$/iu);
      if (suffix) {
        time = suffix[1];
        place = place.slice(0, suffix.index).trim();
      }
    }
    place = place.replace(/^(?:a|in|nel|nella|da|the)\s+/i, '').trim();
    if (!place || place.length > 60) return null;
    const heading = `${prefixFor(direction)} ${place.toUpperCase()}${time ? ` - ${timeWord(time)}` : ''}`;
    return { heading, action: rest || undefined };
  }

  // "interno casa giorno, <action>" (also INT./EXT. and the English times).
  const heading = input.match(HEADING_IT);
  if (heading) {
    const place = heading[2].trim();
    if (!place) return null;
    const time = timeWord(heading[3]);
    const rest = heading[4].trim();
    return {
      heading: `${prefixFor(heading[1])} ${place.toUpperCase()}${time ? ` - ${time}` : ''}`,
      action: rest || undefined,
    };
  }

  return null;
}
