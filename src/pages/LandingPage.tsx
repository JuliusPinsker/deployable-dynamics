import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CONFIGURATIONS, MATERIAL_PRESETS, type ConfigType, type MaterialPresetKey } from '@/lib/physics/types';
import { ArrowRight, Orbit, BarChart3, Zap } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import { scenarioSearch } from '@/hooks/useScenario';
import { DEFAULT_SCENARIO } from '@/lib/scenario/scenarioSpec';

const CONFIG_COLORS = ['hsl(210, 100%, 55%)', 'hsl(168, 70%, 45%)', 'hsl(35, 95%, 55%)', 'hsl(280, 65%, 55%)'];
const CONFIG_ICONS = ['◧', '◫', '⊞', '⊠'];

export default function LandingPage() {
  const navigate = useNavigate();
  const [selectedMaterial, setSelectedMaterial] = useState<MaterialPresetKey>('fr4');
  const activeMaterial = useMemo(
    () => MATERIAL_PRESETS.find(preset => preset.key === selectedMaterial)!,
    [selectedMaterial],
  );
  // The material chosen here starts the scenario. It travels as a URL parameter, not router
  // state — so it survives a refresh, a copied link, and every later navigation.
  const scenario = useMemo(
    () => ({ ...DEFAULT_SCENARIO, material: selectedMaterial }),
    [selectedMaterial],
  );
  const handleSimNavigation = (path: string, config?: ConfigType) => {
    navigate({
      pathname: path,
      search: scenarioSearch(config ? { ...scenario, config } : scenario),
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader scenario={scenario} active="/" />

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-20 pb-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-xs font-medium px-3 py-1 rounded-full">
              <Orbit className="h-3 w-3" />
              Interactive Research Platform
            </div>
            <div className="inline-flex items-center gap-2 bg-secondary/10 text-secondary text-xs font-medium px-3 py-1 rounded-full">
              <span className="font-mono">3U</span>
              100×100×340.5 mm
            </div>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-4">
            CubeSat Solar Panel
            <br />
            <span className="text-primary">Deployable Dynamics</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl mx-auto text-lg leading-relaxed">
            Compare four solar panel deployable configurations with real-time rigid body dynamics simulation.
            Explore deployment anomalies, angular momentum coupling, and impact forces.
          </p>
          <div className="mt-8 max-w-3xl mx-auto">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Panel material</div>
            <div
              role="radiogroup"
              aria-label="Panel material"
              className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3"
            >
              {MATERIAL_PRESETS.map(preset => (
                <button
                  key={preset.key}
                  type="button"
                  role="radio"
                  aria-checked={selectedMaterial === preset.key}
                  onClick={() => setSelectedMaterial(preset.key)}
                  className={`text-left rounded-lg border p-3 transition-colors ${
                    selectedMaterial === preset.key
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-card/60 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                >
                  <div className="font-semibold text-sm">{preset.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {preset.massGrams} g - {preset.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-3 justify-center mt-8">
            <Button size="lg" onClick={() => handleSimNavigation('/simulate')} className="gap-2">
              Launch Simulation <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => handleSimNavigation('/compare')}
              className="gap-2"
            >
              <BarChart3 className="h-4 w-4" /> Compare All
            </Button>
          </div>
        </motion.div>
      </section>

      {/* Config Cards */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CONFIGURATIONS.map((config, i) => (
            <motion.div
              key={config.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 * i }}
            >
              <Card
                className="cursor-pointer hover:border-primary/40 transition-all group"
                onClick={() => handleSimNavigation('/simulate', config.id)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start gap-4">
                    <div
                      className="w-12 h-12 rounded-lg flex items-center justify-center text-2xl shrink-0"
                      style={{ backgroundColor: CONFIG_COLORS[i] + '20', color: CONFIG_COLORS[i] }}
                    >
                      {CONFIG_ICONS[i]}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-sm">{config.name}</h3>
                        <span className="text-xs font-mono text-muted-foreground">{config.panelCount}P</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                        {config.description}
                      </p>
                      <div className="mt-3 flex items-center text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        Open simulation <ArrowRight className="h-3 w-3 ml-1" />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Key metrics teaser */}
      <section className="border-t border-border bg-card/50">
        <div className="max-w-5xl mx-auto px-6 py-12">
          <div className="grid grid-cols-3 gap-8 text-center">
            <div>
              <div className="text-3xl font-bold text-primary">4</div>
              <div className="text-xs text-muted-foreground mt-1">Configuration Types</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-accent">60fps</div>
              <div className="text-xs text-muted-foreground mt-1">Real-time Physics</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-config-3">6 DOF</div>
              <div className="text-xs text-muted-foreground mt-1">Dynamics Model</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
