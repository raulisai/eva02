'use client';

import { useState, useEffect } from 'react';
import { MapPin, Loader2, RefreshCw, XCircle, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { coreFetch } from '@/lib/core-api';

export interface InteractiveFormBubbleProps {
  taskId: string;
  orgId: string;
  message?: string;
  form?: {
    form_key?: string;
    title?: string;
    description?: string;
    fields?: Array<{
      id: string;
      type?: string; // 'text' | 'number' | 'textarea'
      label?: string;
      placeholder?: string;
      required?: boolean;
      profile_path?: string;
    }>;
  };
  onSubmit: (values: Record<string, string>) => Promise<void>;
}

export function InteractiveFormBubble({
  taskId,
  orgId,
  message,
  form,
  onSubmit,
}: InteractiveFormBubbleProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [loadingLocation, setLoadingLocation] = useState<Record<string, boolean>>({});
  const [locationError, setLocationError] = useState<string | null>(null);

  // Initialize form fields
  useEffect(() => {
    if (form?.fields) {
      const initialValues: Record<string, string> = {};
      form.fields.forEach((field) => {
        initialValues[field.id] = '';
      });
      setValues(initialValues);
    }
  }, [form]);

  if (!form) return null;

  const handleInputChange = (id: string, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  };

  const handleReset = () => {
    const clearedValues: Record<string, string> = {};
    form.fields?.forEach((field) => {
      clearedValues[field.id] = '';
    });
    setValues(clearedValues);
    setLocationError(null);
  };

  const handleCancelTask = async () => {
    setCancelling(true);
    try {
      await coreFetch(`/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' }),
      });
    } catch (err) {
      console.error('Error cancelling task:', err);
    } finally {
      setCancelling(false);
    }
  };

  const handleGetCurrentLocation = (fieldId: string) => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      setLocationError('La geolocalización no está soportada por tu navegador.');
      return;
    }

    setLoadingLocation((prev) => ({ ...prev, [fieldId]: true }));
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&accept-language=es`
          );
          if (res.ok) {
            const data = await res.json();
            const address = data.display_name || `${latitude}, ${longitude}`;
            handleInputChange(fieldId, address);
          } else {
            handleInputChange(fieldId, `${latitude}, ${longitude}`);
          }
        } catch (err) {
          console.error('Error fetching address:', err);
          handleInputChange(fieldId, `${latitude}, ${longitude}`);
        } finally {
          setLoadingLocation((prev) => ({ ...prev, [fieldId]: false }));
        }
      },
      (err) => {
        console.error('Geolocation error:', err);
        setLocationError('No se pudo obtener la ubicación. Permiso denegado o error de red.');
        setLoadingLocation((prev) => ({ ...prev, [fieldId]: false }));
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      console.error('Error submitting form:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const isLocationField = (fieldId: string) => {
    const idLower = fieldId.toLowerCase();
    return idLower.includes('origin') || idLower.includes('location') || idLower.includes('pickup') || idLower.includes('destino') || idLower.includes('destination') || idLower.includes('dropoff');
  };

  return (
    <div className="flex justify-start animate-slide-up w-full max-w-[85%]">
      <div className="w-full border border-cyan-500/30 bg-zinc-950/90 rounded-sm p-4 space-y-3 shadow-xl">
        {/* Title & Description */}
        <div className="space-y-1">
          <h4 className="text-xs font-mono font-bold text-cyan-400 uppercase tracking-wider">
            {form.title || 'Formulario'}
          </h4>
          {form.description && (
            <p className="text-[11px] text-zinc-400 leading-relaxed font-mono">
              {form.description}
            </p>
          )}
        </div>

        {message && message !== form.description && (
          <p className="text-[11px] text-zinc-300 font-mono italic">{message}</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {form.fields?.map((field) => {
            const isLoc = isLocationField(field.id);
            const value = values[field.id] || '';

            return (
              <div key={field.id} className="space-y-1">
                <label
                  htmlFor={field.id}
                  className="block text-[10px] font-mono text-zinc-400 uppercase tracking-wide"
                >
                  {field.label || field.id} {field.required && <span className="text-red-400">*</span>}
                </label>

                <div className="relative flex items-center">
                  {field.type === 'textarea' ? (
                    <textarea
                      id={field.id}
                      required={field.required}
                      placeholder={field.placeholder}
                      value={value}
                      onChange={(e) => handleInputChange(field.id, e.target.value)}
                      rows={3}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 font-mono resize-none"
                    />
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : 'text'}
                      id={field.id}
                      required={field.required}
                      placeholder={field.placeholder}
                      value={value}
                      onChange={(e) => handleInputChange(field.id, e.target.value)}
                      className={`w-full bg-zinc-900 border border-zinc-800 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 font-mono ${
                        isLoc ? 'pr-9' : ''
                      }`}
                    />
                  )}

                  {isLoc && field.type !== 'textarea' && (
                    <button
                      type="button"
                      onClick={() => handleGetCurrentLocation(field.id)}
                      disabled={loadingLocation[field.id]}
                      title="Usar ubicación del dispositivo"
                      className="absolute right-2 text-zinc-500 hover:text-cyan-400 disabled:text-zinc-700 transition-colors"
                    >
                      {loadingLocation[field.id] ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <MapPin className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {locationError && (
            <p className="text-[10px] font-mono text-amber-400">{locationError}</p>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-900">
            <Button
              type="submit"
              size="sm"
              disabled={submitting || cancelling}
              className="bg-cyan-600 hover:bg-cyan-700 text-zinc-100 font-mono text-[11px]"
            >
              {submitting ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
              ) : (
                <Send className="w-3 h-3 mr-1.5" />
              )}
              Enviar
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={submitting || cancelling}
              className="border-zinc-800 hover:bg-zinc-900 text-zinc-400 font-mono text-[11px]"
            >
              <RefreshCw className="w-3 h-3 mr-1.5" />
              Reiniciar
            </Button>

            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleCancelTask}
              disabled={submitting || cancelling}
              className="bg-red-950/40 border border-red-900/40 hover:bg-red-900/60 text-red-300 font-mono text-[11px] ml-auto"
            >
              {cancelling ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
              ) : (
                <XCircle className="w-3 h-3 mr-1.5" />
              )}
              Cancelar Viaje
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
