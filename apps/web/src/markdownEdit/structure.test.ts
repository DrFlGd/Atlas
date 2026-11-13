import { describe, expect, it } from 'vitest';
import { readBlock, writeBlock, type ListModel, type TableModel } from './blocks';
import { parseInline } from './inline';
import {
  addColumn,
  addRow,
  alignColumn,
  indentItem,
  outdentItem,
  removeColumn,
  removeItem,
  removeRow,
  setCell,
  setItemContent,
  setOrdered,
  splitItem,
} from './structure';

const list = (text: string) => readBlock(text) as ListModel;
const table = (text: string) => readBlock(text) as TableModel;

describe('the list tools', () => {
  const source = '- one\n- two\n  - inner\n- three';

  it('changes an item, nested or not, and keeps the others as written', () => {
    expect(writeBlock(setItemContent(list(source), [1, 0], parseInline('**in**')), source)).toBe(
      '- one\n- two\n  - **in**\n- three',
    );
  });

  it('splits an item at Enter, and takes one away', () => {
    const split = splitItem(list(source), [0], parseInline('o'), parseInline('ne'));
    expect(split.path).toEqual([1]);
    expect(writeBlock(split.list, source)).toBe('- o\n- ne\n- two\n  - inner\n- three');
    expect(writeBlock(removeItem(list(source), [1]), source)).toBe('- one\n- inner\n- three');
  });

  it('indents and outdents', () => {
    const indented = indentItem(list(source), [2])!;
    expect(indented.path).toEqual([1, 1]);
    expect(writeBlock(indented.list)).toBe('- one\n- two\n  - inner\n  - three');
    const back = outdentItem(indented.list, indented.path)!;
    expect(back.path).toEqual([2]);
    expect(writeBlock(back.list)).toBe('- one\n- two\n  - inner\n- three');
    expect(indentItem(list(source), [0])).toBeNull();
    expect(outdentItem(list(source), [0])).toBeNull();
  });

  it('switches between bullets and numbers', () => {
    expect(writeBlock(setOrdered(list('- a\n- b'), true))).toBe('1. a\n2. b');
  });
});

describe('the table tools', () => {
  const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';

  it('edits a cell, adds and takes away rows and columns, and aligns', () => {
    expect(writeBlock(setCell(table(source), 1, 1, parseInline('two')), source)).toBe(
      '| A | B |\n| --- | --- |\n| 1 | two |',
    );
    expect(writeBlock(addRow(table(source), 1), source)).toBe(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n| | |',
    );
    expect(writeBlock(removeRow(table(source), 1), source)).toBe('| A | B |\n| --- | --- |');
    const wider = addColumn(table(source), 0);
    expect(wider.header.length).toBe(3);
    expect(writeBlock(removeColumn(wider, 1), source)).toBe(source);
    expect(writeBlock(alignColumn(table(source), 1, 'right'), source)).toContain('| --- | ---: |');
  });
});
