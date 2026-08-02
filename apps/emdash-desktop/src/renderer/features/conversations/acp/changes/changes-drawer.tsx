import { observer } from 'mobx-react-lite';
import { Sheet, SheetContent } from '@renderer/lib/ui/sheet';
import type { ChangesFootprint, ChangesFootprintEntry } from './acp-changes-footprint';
import { ChangesRailContent } from './changes-rail-content';
import type { ChangesRailViewStore } from './changes-rail-store';

export interface ChangesDrawerProps {
  store: ChangesRailViewStore;
  footprint: ChangesFootprint;
  onSelectEntry: (entry: ChangesFootprintEntry) => void;
}

/**
 * Narrow-layout Changes drawer: the same content as `ChangesRail`, presented
 * as an overlay `Sheet` instead of an inline sidebar so narrow panels never
 * get page-level horizontal overflow — the drawer is `position: fixed` and
 * scrolls only within its own surface.
 */
export const ChangesDrawer = observer(function ChangesDrawer({
  store,
  footprint,
  onSelectEntry,
}: ChangesDrawerProps) {
  return (
    <Sheet open={store.isOpen} onOpenChange={(open) => store.setOpen(open)}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-80 gap-0 p-0 sm:max-w-xs"
        aria-label="Changes"
      >
        <ChangesRailContent
          footprint={footprint}
          filter={store.filter}
          onFilterChange={(filter) => store.setFilter(filter)}
          selectedPath={store.selectedPath}
          onSelectEntry={(entry) => {
            store.setSelectedPath(entry.path);
            onSelectEntry(entry);
            store.setOpen(false);
          }}
          onClose={() => store.setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
});
