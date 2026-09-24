/** Keep native DSH inputs above scrolling content without changing DSH core. */
export function mountFloatingComposers() {
  let frame = 0;
  const seats = new Set<HTMLElement>();
  const observed = new Set<Element>();
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  const resize = new ResizeObserver(schedule);
  const observe = (element: Element) => {
    if (!observed.has(element)) { observed.add(element); resize.observe(element); }
  };
  const clear = (seat: HTMLElement) => {
    seat.removeAttribute("data-gea-floating-composer");
    for (const key of ["--gea-composer-left", "--gea-composer-width", "--gea-composer-bottom"])
      seat.style.removeProperty(key);
  };
  function sync() {
    frame = 0;
    for (const seat of seats) if (!seat.isConnected) { clear(seat); seats.delete(seat); }
    for (const element of observed) if (!element.isConnected) { resize.unobserve(element); observed.delete(element); }
    document.querySelectorAll<HTMLElement>('.AppFrame_frame [data-slot="main.conversation"] [data-composer-seat]').forEach(seat => {
      const column = seat.closest<HTMLElement>('.AppFrame_rightbarCol, .AppFrame_centerCol');
      const surface = seat.closest<HTMLElement>('[data-phase]');
      const scroll = seat.closest<HTMLElement>('[data-conversation-scroll]');
      const card = seat.querySelector<HTMLElement>('[data-composer-card]');
      if (!column || !surface || !scroll || !card) return;
      seats.add(seat);
      [column, surface, seat, card].forEach(observe);
      const box = column.getBoundingClientRect();
      if (!box.width || !box.height || !seat.getClientRects().length) { clear(seat); return; }
      seat.setAttribute('data-gea-floating-composer', '');
      seat.style.setProperty('--gea-composer-left', `${box.left + column.clientLeft}px`);
      seat.style.setProperty('--gea-composer-width', `${column.clientWidth}px`);
      // Host variants include different padding/dock wrappers below the card.
      // Align the visible card border, rather than the wrapper's invisible edge.
      const tail = seat.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom;
      seat.style.setProperty('--gea-composer-bottom', `${20 - tail}px`);
      const reserve = `${Math.ceil(seat.getBoundingClientRect().height + 36)}px`;
      scroll.style.setProperty('--gea-composer-reserve', reserve);
      surface.style.setProperty('--gea-composer-reserve', reserve);
    });
  }
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    seats.forEach(clear);
    document.querySelectorAll<HTMLElement>('[style*="--gea-composer-reserve"]').forEach(element => element.style.removeProperty('--gea-composer-reserve'));
  };
}
