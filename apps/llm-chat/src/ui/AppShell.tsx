/**
 * The four-region layout: a sidebar, a header, the scrolling body, and a sticky composer.
 *
 * `AppShell` takes no chat concept at all -- just four `ReactNode`s -- so it is testable without a
 * controller and the mesh page (Task 11) reuses it unchanged.
 *
 * `sidebar` is rendered once. It shows as a permanent column at `md` and above; below `md` that
 * column collapses (CSS only -- Task 13's Playwright specs prove that at a real viewport, not this
 * file) and a menu button opens the *same* `sidebar` node inside a `Sheet`. While that Sheet is
 * open, the desktop copy is pulled out of the accessibility tree (`inert` + `aria-hidden`) so a
 * screen reader is never offered two copies of the conversation list at once -- see
 * `tests/app-shell.test.tsx`'s "exactly one accessible copy" case.
 *
 * `composer` is optional in effect: a consumer with nothing to put there (e.g. `ChatApp`, whose
 * `Thread` still owns its own composer inline -- Task 6 does not touch `Thread.tsx`) can pass
 * `null`, and the sticky footer region -- border and safe-area padding included -- simply does not
 * render, rather than showing as an empty strip.
 */

import { MenuIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "./primitives/button.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "./primitives/sheet.js";

export interface AppShellProps {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
  composer: ReactNode;
}

export function AppShell({ sidebar, header, children, composer }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="grid h-dvh grid-cols-1 grid-rows-[auto_1fr_auto] md:grid-cols-[16rem_1fr]">
      <div
        className="hidden flex-col overflow-hidden border-r md:col-start-1 md:row-span-3 md:flex"
        // Pulled out of the a11y tree while the Sheet shows the same content, so assistive tech
        // is never offered two copies of the conversation list at once.
        inert={menuOpen}
        aria-hidden={menuOpen}
      >
        {sidebar}
      </div>

      <header className="flex items-center gap-2 border-b px-4 py-2 md:col-start-2">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Conversations">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-3/4 flex-col gap-0 p-0 sm:max-w-xs">
            <SheetHeader className="sr-only">
              <SheetTitle>Conversations</SheetTitle>
            </SheetHeader>
            {sidebar}
          </SheetContent>
        </Sheet>
        <div className="flex min-w-0 flex-1 items-center gap-3">{header}</div>
      </header>

      <main className="min-h-0 overflow-y-auto md:col-start-2">{children}</main>

      {composer != null && (
        <footer className="sticky bottom-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:col-start-2">
          {composer}
        </footer>
      )}
    </div>
  );
}
