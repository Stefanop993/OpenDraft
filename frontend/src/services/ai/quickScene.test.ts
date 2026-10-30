import { describe, it, expect } from 'vitest';
import { parseQuickScene } from './quickScene';

describe('parseQuickScene', () => {
  it('turns an Italian move outside into a scene heading and action', () => {
    expect(parseQuickScene('ora siamo fuori casa, poco dopo. vilgax sta cacando')).toEqual({
      heading: 'EXT. CASA - LATER',
      action: 'vilgax sta cacando',
    });
  });

  it('understands inside and a time of day', () => {
    expect(parseQuickScene('siamo dentro casa, di notte. Ben dorme.')).toEqual({
      heading: 'INT. CASA - NIGHT',
      action: 'Ben dorme.',
    });
  });

  it('reads an explicit heading at the start', () => {
    expect(parseQuickScene('interno casa giorno, ben entra arrabbiato.')).toEqual({
      heading: 'INT. CASA - DAY',
      action: 'ben entra arrabbiato.',
    });
    expect(parseQuickScene('EXT. LAUNDRY - NIGHT, Ada waits.')).toEqual({
      heading: 'EXT. LAUNDRY - NIGHT',
      action: 'Ada waits.',
    });
  });

  it('understands the English move', () => {
    expect(parseQuickScene('We are outside the house, a little later. Vilgax waits.')).toEqual({
      heading: 'EXT. HOUSE - LATER',
      action: 'Vilgax waits.',
    });
  });

  it('leaves dialogue and ordinary action to the model', () => {
    expect(parseQuickScene('Ben dice: Ciao a tutti.')).toBeNull();
    expect(parseQuickScene('Ben entra in casa e si siede.')).toBeNull();
  });

  it('ignores very long prompts', () => {
    expect(parseQuickScene('siamo fuori casa, poco dopo. ' + 'x'.repeat(700))).toBeNull();
  });
});
