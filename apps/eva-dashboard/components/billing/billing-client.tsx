'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { 
  Coins, RotateCw, Cpu, Brain, Code, MessageSquare, AlertCircle, TrendingUp, BarChart3, HelpCircle 
} from 'lucide-react';
import { coreFetch } from '@/lib/core-api';

interface BillingStats {
  summary: {
    total_cost_usd: number;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_requests: number;
  };
  by_model: Array<{
    model: string;
    request_count: number;
    total_tokens: number;
    cost_usd: number;
  }>;
  by_type: Array<{
    request_type: string;
    request_count: number;
    total_tokens: number;
    cost_usd: number;
  }>;
  by_day: Array<{
    date: string;
    total_tokens: number;
    cost_usd: number;
  }>;
}

interface BillingClientProps {
  initialStats: BillingStats;
  orgId: string;
}

export function BillingClient({ initialStats, orgId }: BillingClientProps) {
  const [stats, setStats] = useState<BillingStats>(initialStats);
  const [loading, setLoading] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState<{ date: string; cost: number; x: number; y: number } | null>(null);

  async function handleRefresh() {
    setLoading(true);
    try {
      const data = await coreFetch<BillingStats>('/billing/stats');
      setStats(data);
    } catch (err) {
      console.error('Failed to reload billing stats:', err);
    } finally {
      setLoading(false);
    }
  }

  const { summary, by_model, by_type, by_day } = stats;

  const totalCost = Number(summary.total_cost_usd || 0);
  const totalTokens = summary.total_tokens || 0;
  const promptTokens = summary.prompt_tokens || 0;
  const completionTokens = summary.completion_tokens || 0;
  const totalRequests = summary.total_requests || 0;
  const avgCostPerRequest = totalRequests > 0 ? totalCost / totalRequests : 0;

  // Find most used model (highest request count)
  let mostUsedModel = '';
  let maxRequests = -1;
  by_model.forEach(m => {
    if (m.request_count > maxRequests) {
      maxRequests = m.request_count;
      mostUsedModel = m.model;
    }
  });

  // Calculate Request Type percentages
  const typeMap = by_type.reduce((acc, t) => {
    acc[t.request_type] = {
      tokens: t.total_tokens,
      cost: t.cost_usd,
      count: t.request_count,
    };
    return acc;
  }, {} as Record<string, { tokens: number; cost: number; count: number }>);

  const requestTypes = [
    { key: 'reasoning', label: 'Reasoning', color: 'bg-cyan-500', textColor: 'text-cyan-400', icon: Brain },
    { key: 'tools', label: 'Tools', color: 'bg-indigo-500', textColor: 'text-indigo-400', icon: BarChart3 },
    { key: 'code', label: 'Code Gen', color: 'bg-emerald-500', textColor: 'text-emerald-400', icon: Code },
    { key: 'response', label: 'Response', color: 'bg-amber-500', textColor: 'text-amber-400', icon: MessageSquare },
  ];

  // SVG Daily Spending Chart computations
  const chartWidth = 600;
  const chartHeight = 240;
  const paddingX = 40;
  const paddingY = 30;

  const points = by_day || [];
  const maxCost = Math.max(...points.map(d => Number(d.cost_usd)), 0.005);
  
  // Format daily date strings (MM-DD)
  const formatChartDate = (dateStr: string) => {
    try {
      const [, month, day] = dateStr.split('-');
      return `${month}/${day}`;
    } catch {
      return dateStr;
    }
  };

  // Generate SVG coordinates
  const svgCoordinates = points.map((p, idx) => {
    const x = paddingX + (idx / Math.max(points.length - 1, 1)) * (chartWidth - paddingX * 2);
    const y = chartHeight - paddingY - (Number(p.cost_usd) / maxCost) * (chartHeight - paddingY * 2);
    return { x, y, date: p.date, cost: Number(p.cost_usd) };
  });

  // SVG Path strings
  let linePath = '';
  let areaPath = '';
  if (svgCoordinates.length > 0) {
    linePath = `M ${svgCoordinates[0].x} ${svgCoordinates[0].y} ` + 
      svgCoordinates.slice(1).map(c => `L ${c.x} ${c.y}`).join(' ');
    
    areaPath = `${linePath} L ${svgCoordinates[svgCoordinates.length - 1].x} ${chartHeight - paddingY} L ${svgCoordinates[0].x} ${chartHeight - paddingY} Z`;
  }

  return (
    <div className="space-y-6">
      {/* Header Toolbar */}
      <div className="flex justify-between items-center bg-zinc-900/40 border border-zinc-800/60 p-4 rounded-lg backdrop-blur-md">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <Coins className="w-4 h-4 text-cyan-400" />
            Consumo en tokens y costes
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">Organización ID: <span className="font-mono text-zinc-500">{orgId}</span></p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-sm bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50 text-xs font-medium transition-all duration-200"
        >
          <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Recargar
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Cost Card */}
        <div className="bg-gradient-to-br from-zinc-900 to-zinc-950/60 border border-zinc-800/80 p-5 rounded-lg flex flex-col justify-between hover:border-cyan-500/30 transition-all duration-300 relative group overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl group-hover:bg-cyan-500/10 transition-all duration-300" />
          <div className="flex justify-between items-start">
            <span className="text-xs font-medium text-zinc-400">Gasto Total</span>
            <div className="w-7 h-7 rounded bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
              <Coins className="w-3.5 h-3.5 text-cyan-400" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-semibold text-zinc-50 tracking-tight">${totalCost.toFixed(4)}</h3>
            <p className="text-[10px] text-zinc-500 mt-1 flex items-center gap-1">
              <TrendingUp className="w-3 h-3 text-cyan-400" />
              USD acumulados por llamadas LLM
            </p>
          </div>
        </div>

        {/* Requests Card */}
        <div className="bg-gradient-to-br from-zinc-900 to-zinc-950/60 border border-zinc-800/80 p-5 rounded-lg flex flex-col justify-between hover:border-indigo-500/30 transition-all duration-300 relative group overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl group-hover:bg-indigo-500/10 transition-all duration-300" />
          <div className="flex justify-between items-start">
            <span className="text-xs font-medium text-zinc-400">Peticiones Totales</span>
            <div className="w-7 h-7 rounded bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <Cpu className="w-3.5 h-3.5 text-indigo-400" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-semibold text-zinc-50 tracking-tight">{totalRequests.toLocaleString()}</h3>
            <p className="text-[10px] text-zinc-500 mt-1">Llamadas totales a proveedores de IA</p>
          </div>
        </div>

        {/* Tokens Card */}
        <div className="bg-gradient-to-br from-zinc-900 to-zinc-950/60 border border-zinc-800/80 p-5 rounded-lg flex flex-col justify-between hover:border-emerald-500/30 transition-all duration-300 relative group overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-all duration-300" />
          <div className="flex justify-between items-start">
            <span className="text-xs font-medium text-zinc-400">Tokens Consumidos</span>
            <div className="w-7 h-7 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <BarChart3 className="w-3.5 h-3.5 text-emerald-400" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-semibold text-zinc-50 tracking-tight">{totalTokens.toLocaleString()}</h3>
            <p className="text-[10px] text-zinc-500 mt-1">
              {promptTokens.toLocaleString()} in / {completionTokens.toLocaleString()} out
            </p>
          </div>
        </div>

        {/* Average Cost Card */}
        <div className="bg-gradient-to-br from-zinc-900 to-zinc-950/60 border border-zinc-800/80 p-5 rounded-lg flex flex-col justify-between hover:border-amber-500/30 transition-all duration-300 relative group overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl group-hover:bg-amber-500/10 transition-all duration-300" />
          <div className="flex justify-between items-start">
            <span className="text-xs font-medium text-zinc-400">Coste Promedio</span>
            <div className="w-7 h-7 rounded bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-semibold text-zinc-50 tracking-tight">${avgCostPerRequest.toFixed(5)}</h3>
            <p className="text-[10px] text-zinc-500 mt-1">Costo promedio por petición LLM</p>
          </div>
        </div>
      </div>

      {/* Empty State Fallback */}
      {totalRequests === 0 ? (
        <div className="bg-zinc-900/20 border border-zinc-800 p-12 rounded-lg flex flex-col items-center justify-center text-center space-y-4 max-w-2xl mx-auto mt-8">
          <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700">
            <AlertCircle className="w-6 h-6 text-zinc-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">Sin datos de facturación</h3>
            <p className="text-xs text-zinc-400 mt-2 max-w-sm">
              Aún no se ha realizado ninguna llamada a modelos de lenguaje en esta organización.
              Ve a la sección de <a href="/playground" className="text-cyan-400 hover:underline">Playground</a> o interactúa con EVA en tus canales para empezar a generar estadísticas de consumo.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Daily Trend & Request Types */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* SVG Interactive Area Chart */}
            <div className="lg:col-span-2 bg-zinc-900/30 border border-zinc-800/80 p-5 rounded-lg flex flex-col justify-between">
              <div>
                <h3 className="text-xs font-semibold text-zinc-200 tracking-wide uppercase">Gasto Diario (Últimos 30 días)</h3>
                <p className="text-[10px] text-zinc-500 mt-0.5">Representación gráfica de coste diario en USD</p>
              </div>

              <div className="my-6 relative w-full h-[240px]">
                {points.length < 2 ? (
                  <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-xs font-mono">
                    Registrando los primeros días de gasto...
                  </div>
                ) : (
                  <>
                    <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full h-full overflow-visible">
                      <defs>
                        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.25" />
                          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
                        </linearGradient>
                      </defs>

                      {/* Grid Y lines */}
                      {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
                        const y = paddingY + ratio * (chartHeight - paddingY * 2);
                        const value = maxCost * (1 - ratio);
                        return (
                          <g key={idx} className="opacity-20">
                            <line x1={paddingX} y1={y} x2={chartWidth - paddingX} y2={y} stroke="#52525b" strokeWidth={1} strokeDasharray="4" />
                            <text x={paddingX - 8} y={y + 4} fill="#a1a1aa" fontSize={10} textAnchor="end" fontFamily="monospace">
                              ${value.toFixed(3)}
                            </text>
                          </g>
                        );
                      })}

                      {/* Area Fill */}
                      <path d={areaPath} fill="url(#chartGrad)" />

                      {/* Line Path */}
                      <path d={linePath} fill="none" stroke="#22d3ee" strokeWidth={2} />

                      {/* Hover interactive circle & guide lines */}
                      {hoveredPoint && (
                        <g>
                          <line x1={hoveredPoint.x} y1={paddingY} x2={hoveredPoint.x} y2={chartHeight - paddingY} stroke="#22d3ee" strokeWidth={1} strokeDasharray="3" className="opacity-50" />
                          <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r={5} fill="#22d3ee" stroke="#09090b" strokeWidth={1.5} />
                        </g>
                      )}

                      {/* Hover touch target circles */}
                      {svgCoordinates.map((coord, idx) => (
                        <circle
                          key={idx}
                          cx={coord.x}
                          cy={coord.y}
                          r={10}
                          fill="transparent"
                          className="cursor-pointer"
                          onMouseEnter={() => setHoveredPoint(coord)}
                          onMouseLeave={() => setHoveredPoint(null)}
                        />
                      ))}

                      {/* X Axis dates (Sampled to prevent clutter) */}
                      {points.map((p, idx) => {
                        if (points.length > 7 && idx % Math.ceil(points.length / 6) !== 0 && idx !== points.length - 1) return null;
                        const x = paddingX + (idx / (points.length - 1)) * (chartWidth - paddingX * 2);
                        return (
                          <text key={idx} x={x} y={chartHeight - 8} fill="#71717a" fontSize={9} textAnchor="middle" fontFamily="monospace">
                            {formatChartDate(p.date)}
                          </text>
                        );
                      })}
                    </svg>

                    {/* Tooltip Overlay */}
                    {hoveredPoint && (
                      <div 
                        className="absolute p-2 bg-zinc-900 border border-cyan-500/40 rounded shadow-xl text-[10px] font-mono pointer-events-none transform -translate-y-full -translate-x-1/2 flex flex-col gap-0.5"
                        style={{ 
                          left: `${(hoveredPoint.x / chartWidth) * 100}%`, 
                          top: `${(hoveredPoint.y / chartHeight) * 100 - 5}%` 
                        }}
                      >
                        <span className="text-zinc-400 font-semibold">{hoveredPoint.date}</span>
                        <span className="text-cyan-400 font-bold">${hoveredPoint.cost.toFixed(5)} USD</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Request Type Distribution */}
            <div className="bg-zinc-900/30 border border-zinc-800/80 p-5 rounded-lg flex flex-col justify-between">
              <div>
                <h3 className="text-xs font-semibold text-zinc-200 tracking-wide uppercase">Distribución de tokens</h3>
                <p className="text-[10px] text-zinc-500 mt-0.5">División de tokens por tipo de peticiones</p>
              </div>

              <div className="space-y-4 my-auto py-2">
                {requestTypes.map(({ key, label, color, textColor, icon: Icon }) => {
                  const typeData = typeMap[key] || { tokens: 0, cost: 0, count: 0 };
                  const percentage = totalTokens > 0 ? (typeData.tokens / totalTokens) * 100 : 0;
                  
                  return (
                    <div key={key} className="space-y-1 group">
                      <div className="flex justify-between items-center text-xs">
                        <span className="flex items-center gap-1.5 text-zinc-300 font-medium">
                          <Icon className={`w-3.5 h-3.5 ${textColor}`} />
                          {label}
                        </span>
                        <span className="font-mono text-zinc-400 text-[10px]">
                          {typeData.tokens.toLocaleString()} t ({percentage.toFixed(1)}%)
                        </span>
                      </div>
                      
                      <div className="w-full h-2 bg-zinc-850 rounded-full overflow-hidden border border-zinc-800/60">
                        <div 
                          className={`h-full ${color} transition-all duration-500`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>

                      <div className="flex justify-between text-[9px] text-zinc-500 font-mono opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <span>{typeData.count} peticiones</span>
                        <span>${Number(typeData.cost || 0).toFixed(5)} USD</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Model Breakdown */}
          <div className="bg-zinc-900/20 border border-zinc-850 p-5 rounded-lg space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-zinc-200 tracking-wide uppercase">Consumo por Modelos</h3>
              <p className="text-[10px] text-zinc-500 mt-0.5 font-sans">Métricas específicas registradas de cada modelo LLM</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {by_model.map((m) => {
                const isMostUsed = m.model === mostUsedModel;
                const costPercentage = totalCost > 0 ? (Number(m.cost_usd) / totalCost) * 100 : 0;
                
                return (
                  <div 
                    key={m.model} 
                    className={`p-4 rounded-lg bg-zinc-900/40 border border-zinc-800/60 flex flex-col justify-between space-y-3 relative overflow-hidden group hover:border-zinc-700/60 transition-all duration-300 ${
                      isMostUsed ? 'ring-1 ring-cyan-500/20 shadow-md shadow-cyan-950/20' : ''
                    }`}
                  >
                    {isMostUsed && (
                      <div className="absolute top-0 right-0 px-2 py-0.5 bg-cyan-500/10 border-l border-b border-cyan-500/20 rounded-bl text-[8px] font-mono font-semibold tracking-wider text-cyan-400 uppercase">
                        Más Usado
                      </div>
                    )}
                    
                    <div>
                      <h4 className="text-xs font-semibold text-zinc-100 truncate w-3/4 font-mono">{m.model}</h4>
                      <p className="text-[9px] text-zinc-500 mt-0.5 font-mono">{m.request_count} peticiones totales</p>
                    </div>

                    <div className="grid grid-cols-2 gap-2 border-t border-zinc-800/40 pt-2.5">
                      <div>
                        <span className="block text-[9px] text-zinc-500 uppercase font-mono tracking-wider">Costo USD</span>
                        <span className="text-xs font-semibold text-zinc-200 font-mono">${Number(m.cost_usd).toFixed(5)}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] text-zinc-500 uppercase font-mono tracking-wider">Tokens</span>
                        <span className="text-xs font-semibold text-zinc-200 font-mono">{m.total_tokens.toLocaleString()}</span>
                      </div>
                    </div>

                    <div className="w-full bg-zinc-850 h-1 rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${isMostUsed ? 'bg-cyan-500' : 'bg-zinc-600'} transition-all`}
                        style={{ width: `${costPercentage}%` }}
                      />
                    </div>
                    <span className="text-[9px] text-zinc-500 font-mono block text-right">
                      Representa {costPercentage.toFixed(1)}% del coste total
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
