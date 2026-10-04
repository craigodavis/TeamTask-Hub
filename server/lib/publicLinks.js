/**
 * Public-facing URLs that staff hand to customers.
 *
 * One definition, because these get read out on the phone and pasted into emails.
 * The Vapi agent texts the event-request form to callers and the Event Requests page
 * displays it for staff to send; if those two ever disagreed, nobody would find out
 * from the code — a customer would land on the wrong page.
 */
export const EVENT_REQUEST_URL =
  process.env.EVENT_REQUEST_URL || 'https://www.kindredvineyards.com/events/request/';
