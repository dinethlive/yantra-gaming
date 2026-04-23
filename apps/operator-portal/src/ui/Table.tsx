import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';

// Thin TanStack Table wrapper — we don't need sort/filter/pagination UI
// inside the component because every API endpoint handles pagination
// server-side (cursor-based). This is just the visual shell.

interface Props<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
}

export default function Table<T>({ columns, data, emptyMessage, onRowClick }: Props<T>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (data.length === 0) {
    return <div className="table-empty">{emptyMessage ?? 'No data'}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} style={{ width: h.getSize() === 150 ? undefined : h.getSize() }}>
                  {h.isPlaceholder
                    ? null
                    : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className={onRowClick ? 'row--clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
