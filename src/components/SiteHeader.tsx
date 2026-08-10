import React from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '@/components/ui/theme-toggle';
import { scenarioSearch } from '@/hooks/useScenario';
import type { ScenarioSpec } from '@/lib/scenario/scenarioSpec';

const NAV_ITEMS = [
  { to: '/', label: 'Overview' },
  { to: '/simulate', label: 'Simulation' },
  { to: '/compare', label: 'Compare' },
  { to: '/report', label: 'Report' },
] as const;

interface SiteHeaderProps {
  /** The scenario to carry into every link. */
  scenario: ScenarioSpec;
  /** Route path of the page rendering this header, used to mark the current nav item. */
  active: (typeof NAV_ITEMS)[number]['to'];
  /**
   * The page's live search params. Passed through verbatim apart from the four scenario keys, so
   * page-specific parameters (notably the Report's configs/failures/materials filters) survive
   * navigation away and back.
   */
  searchParams?: URLSearchParams;
}

/**
 * The one navigation header. Replaces the three hand-rolled `<a href>` headers, which triggered a
 * full page reload and therefore dropped the entire active scenario on every click.
 */
export default function SiteHeader({ scenario, active, searchParams }: SiteHeaderProps) {
  const search = scenarioSearch(scenario, searchParams);

  return (
    <header className="border-b border-border px-6 py-3 flex items-center justify-between">
      <Link to={{ pathname: '/', search }} className="font-semibold text-lg tracking-tight">
        <span className="text-primary">CubeSat</span> Deploy Sim
      </Link>
      <div className="flex items-center gap-4">
        <nav className="flex gap-4 text-sm text-muted-foreground">
          {NAV_ITEMS.map(item => (
            <Link
              key={item.to}
              to={{ pathname: item.to, search }}
              aria-current={item.to === active ? 'page' : undefined}
              className={
                item.to === active
                  ? 'text-foreground'
                  : 'hover:text-foreground transition-colors'
              }
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
