import { MAIN_MENU, surfaceLabel, type WorkbenchSurface } from "./workbench-surface.ts";

export type WorkbenchPresence = {
  inWorkbench: boolean;

  signal: "menu";

  menu: string;

  menuTitle: string;

  menuReportedAt?: string;
};

export function workbenchPresence(input: { surface?: WorkbenchSurface }): WorkbenchPresence {
  const surface = input.surface;
  return {
    inWorkbench: surface !== undefined && surface.menu !== MAIN_MENU,
    signal: "menu",
    menu: surface?.menu ?? MAIN_MENU,
    menuTitle: surfaceLabel(surface),
    ...(surface === undefined ? {} : { menuReportedAt: new Date(surface.at).toISOString() }),
  };
}
