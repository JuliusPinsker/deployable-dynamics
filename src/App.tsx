import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import SimulationPage from "./pages/SimulationPage";
import ComparePage from "./pages/ComparePage";
import ReportPage from "./pages/ReportPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

/**
 * The route table, separated from the router itself so tests can mount the real routes inside a
 * MemoryRouter and exercise navigation between pages (the scenario is carried in the URL, so
 * cross-page behaviour is only observable with the actual routes in place).
 */
export const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/simulate" element={<SimulationPage />} />
    <Route path="/compare" element={<ComparePage />} />
    <Route path="/report" element={<ReportPage />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
);

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="system">
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <div>
            <AppRoutes />
          </div>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
