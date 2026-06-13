import { SensitivityClassifierService } from '../sensitivity-classifier.service';

describe('SensitivityClassifierService', () => {
  const classifier = new SensitivityClassifierService();

  it('marks credentials as sensitive without echoing the secret', () => {
    const result = classifier.classify('mi password es super-secreto-123');

    expect(result).toMatchObject({ sensitivity: 'sensitive', reason: 'credential' });
    expect(result.hint).not.toContain('super-secreto');
  });

  it('returns safe hints for phones and emails', () => {
    expect(classifier.classify('mi telefono es +52 55 1234 9876')).toMatchObject({
      sensitivity: 'personal',
      reason: 'phone',
      hint: '••••9876',
    });
    expect(classifier.classify('correo diego@example.com')).toMatchObject({
      sensitivity: 'personal',
      reason: 'email',
      hint: 'di•••@example.com',
    });
  });

  it('leaves ordinary profile facts as normal', () => {
    expect(classifier.classify('me gusta trabajar por la mañana')).toMatchObject({
      sensitivity: 'normal',
    });
  });
});
