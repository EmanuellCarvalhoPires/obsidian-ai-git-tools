/**
 * Helper to manage paginated lists with a 'show more' action.
 */
export interface PaginationResult<T> {
  pageItems: T[];
  hasMore: boolean;
  total: number;
  shownCount: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number): PaginationResult<T> {
  const count = Math.max(1, page) * pageSize;
  const pageItems = items.slice(0, count);
  return {
    pageItems,
    hasMore: count < items.length,
    total: items.length,
    shownCount: pageItems.length,
  };
}

/**
 * Creates a pagination footer with a 'Show more' button when hasMore is true.
 */
export function renderPaginationControls(
  container: HTMLElement,
  hasMore: boolean,
  shownCount: number,
  total: number,
  onShowMore: () => void,
  labels?: { showMore?: string; info?: string },
): void {
  if (!hasMore && total <= shownCount) return;
  const wrap = container.createDiv({ cls: "aigt-pagination-wrap" });
  if (labels?.info) {
    wrap.createSpan({ text: labels.info, cls: "aigt-pagination-info aigt-muted" });
  } else {
    wrap.createSpan({ text: `${shownCount} / ${total}`, cls: "aigt-pagination-info aigt-muted" });
  }
  if (hasMore) {
    const btn = wrap.createEl("button", {
      text: labels?.showMore ?? "Show more",
      cls: "aigt-pagination-btn",
    });
    btn.addEventListener("click", onShowMore);
  }
}
