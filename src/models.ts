export type CellColorStyle = { rgb?: string };
export type CellBorderStyle = 'thin' | 'medium' | 'thick' | 'dotted' | 'hair' | 'dashed' | 'mediumDashed' | 'dashDot' | 'mediumDashDot' | 'dashDotDot' | 'mediumDashDotDot' | 'slantDashDot';
export type CellBorder = { style: CellBorderStyle, color: CellColorStyle };
export type CellStyle = {
  fill?: {
    fgColor?: CellColorStyle,
  },
  alignment?: {
    vertical?: 'top' | 'center' | 'bottom',
    horizontal?: 'left' | 'center' | 'right',
  },
  font?: {
    bold?: boolean,
    sz?: string,
  },
  border?: {
    top?: CellBorder,
    bottom?: CellBorder,
    left?: CellBorder,
    right?: CellBorder,
  },
  numFmt?: string,
};
export type XLSXCell = string | {
  v: string, t: string, s?: CellStyle, z?: string
};
export type XLSXCol = { wch: number };
export type XLSXMerge = { s: { c: number, r: number }, e: { c: number, r: number } };

export function cellValue(cell: XLSXCell) {
  if (typeof cell === 'string') {
    return cell;
  }
  return cell.v;
}
