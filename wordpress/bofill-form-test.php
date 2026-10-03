<?php
/**
 * Plugin Name: Bofill Weekly Form Test Helper
 * Description: Lets Bofill Technologies' weekly contact-form test confirm delivery. Blind-copies ONLY the weekly test email to the Bofill form-check inbox, records whether WordPress sent it, skips CAPTCHA and marketing integrations for the authenticated test submission only, and trashes the test entry. Real visitor submissions are never touched.
 * Version: 1.0.0
 * Author: Bofill Technologies
 *
 * Install as a must-use plugin: copy to wp-content/mu-plugins/bofill-form-test.php
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Must match the FORMTEST_SECRET GitHub Actions secret in BofillTech/bofilltech-monitor.
if ( ! defined( 'BOFILL_FT_SECRET' ) ) {
	define( 'BOFILL_FT_SECRET', 'REPLACE_WITH_SECRET' );
}
if ( ! defined( 'BOFILL_FT_BCC' ) ) {
	define( 'BOFILL_FT_BCC', 'formcheck@bofilltech.com' );
}
define( 'BOFILL_FT_VERSION', '1.0.0' );
define( 'BOFILL_FT_RE', '/BOFILL-FORMTEST:[a-z0-9-]+:\d{8}:[a-z0-9]{4}/' );

/** True only when this request carries the correct secret header from the Bofill test runner. */
function bofill_ft_is_test_request() {
	static $is = null;
	if ( null !== $is ) {
		return $is;
	}
	$sent = isset( $_SERVER['HTTP_X_BOFILL_FORMTEST'] ) ? (string) $_SERVER['HTTP_X_BOFILL_FORMTEST'] : '';
	$is   = ( '' !== $sent && 'REPLACE_WITH_SECRET' !== BOFILL_FT_SECRET && hash_equals( BOFILL_FT_SECRET, $sent ) );
	return $is;
}

function bofill_ft_find_token( $text ) {
	if ( is_array( $text ) ) {
		$text = implode( ' ', $text );
	}
	return ( is_string( $text ) && preg_match( BOFILL_FT_RE, $text, $m ) ) ? $m[0] : null;
}

/** Store a small status record per test token (kept 10 days, max 20 records). */
function bofill_ft_log( $token, $state, $extra = array() ) {
	$log = get_option( 'bofill_ft_log', array() );
	if ( ! is_array( $log ) ) {
		$log = array();
	}
	$row = isset( $log[ $token ] ) ? $log[ $token ] : array( 'first_seen' => time() );
	// "failed" is sticky over a later "sent" for a different message (e.g. autoresponder)
	if ( ! ( isset( $row['state'] ) && 'failed' === $row['state'] && 'sent' === $state ) ) {
		$row['state'] = $state;
	}
	$row['updated'] = time();
	$row            = array_merge( $row, $extra );
	$log[ $token ]  = $row;
	$cut            = time() - 10 * DAY_IN_SECONDS;
	$log            = array_filter( $log, function ( $r ) use ( $cut ) { return ( $r['updated'] ?? 0 ) > $cut; } );
	if ( count( $log ) > 20 ) {
		$log = array_slice( $log, -20, null, true );
	}
	update_option( 'bofill_ft_log', $log, false );
}

/** Count recipients that are NOT the form-check inbox (i.e. the client's notification addresses). */
function bofill_ft_client_recipients( $to ) {
	$list = is_array( $to ) ? $to : explode( ',', (string) $to );
	$n    = 0;
	foreach ( $list as $addr ) {
		if ( '' !== trim( $addr ) && false === stripos( $addr, BOFILL_FT_BCC ) ) {
			$n++;
		}
	}
	return $n;
}

// 1) Blind-copy the weekly test email (and only that email) to the form-check inbox.
add_filter(
	'wp_mail',
	function ( $args ) {
		$token = bofill_ft_find_token( ( $args['message'] ?? '' ) . ' ' . ( $args['subject'] ?? '' ) );
		if ( ! $token ) {
			return $args;
		}
		$clients = bofill_ft_client_recipients( $args['to'] ?? '' );
		if ( $clients > 0 ) { // client notification: add our copy. Autoresponders to us need no copy.
			$headers = $args['headers'] ?? array();
			if ( ! is_array( $headers ) ) {
				$headers = '' === trim( (string) $headers ) ? array() : explode( "\n", str_replace( "\r\n", "\n", $headers ) );
			}
			$headers[]       = 'Bcc: ' . BOFILL_FT_BCC;
			$args['headers'] = $headers;
			bofill_ft_log( $token, 'pending', array( 'recipients' => $clients ) );
		}
		return $args;
	},
	999
);

// 2) Record whether WordPress actually handed the email off.
add_action(
	'wp_mail_succeeded',
	function ( $mail ) {
		$token = bofill_ft_find_token( ( $mail['message'] ?? '' ) . ' ' . ( $mail['subject'] ?? '' ) );
		if ( $token && bofill_ft_client_recipients( $mail['to'] ?? '' ) > 0 ) {
			bofill_ft_log( $token, 'sent' );
		}
	}
);
add_action(
	'wp_mail_failed',
	function ( $error ) {
		$data  = is_wp_error( $error ) ? (array) $error->get_error_data() : array();
		$token = bofill_ft_find_token( ( $data['message'] ?? '' ) . ' ' . ( $data['subject'] ?? '' ) );
		if ( $token ) {
			bofill_ft_log( $token, 'failed', array( 'error' => substr( $error->get_error_message(), 0, 200 ) ) );
		}
	}
);

// 3) Status endpoints for the test runner.
add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'bofill-formtest/v1',
			'/ping',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					return array( 'ok' => true, 'version' => BOFILL_FT_VERSION );
				},
			)
		);
		register_rest_route(
			'bofill-formtest/v1',
			'/status',
			array(
				'methods'             => 'GET',
				'permission_callback' => 'bofill_ft_is_test_request',
				'callback'            => function ( $req ) {
					$token = (string) $req->get_param( 'token' );
					$log   = get_option( 'bofill_ft_log', array() );
					if ( ! preg_match( BOFILL_FT_RE, $token ) || empty( $log[ $token ] ) ) {
						return array( 'state' => 'pending' );
					}
					$r = $log[ $token ];
					return array(
						'state'      => $r['state'],
						'recipients' => $r['recipients'] ?? null,
						'error'      => $r['error'] ?? null,
					);
				},
			)
		);
	}
);

// Everything below applies ONLY to the authenticated weekly test request.
if ( ! bofill_ft_is_test_request() ) {
	return;
}

// Gravity Forms: pass CAPTCHA fields, never mark as spam, skip add-on feeds (Mailchimp, Zapier, CRMs), trash the entry.
add_filter(
	'gform_field_validation',
	function ( $result, $value, $form, $field ) {
		if ( in_array( $field->type, array( 'captcha', 'recaptcha', 'turnstile', 'hcaptcha' ), true ) ) {
			$result['is_valid'] = true;
			$result['message']  = '';
		}
		return $result;
	},
	999,
	4
);
add_filter( 'gform_entry_is_spam', '__return_false', 999 );
add_filter( 'gform_akismet_enabled', '__return_false', 999 );
add_filter( 'gform_addon_pre_process_feeds', function () { return array(); }, 999 );
add_action(
	'gform_after_submission',
	function ( $entry ) {
		if ( class_exists( 'GFAPI' ) && ! empty( $entry['id'] ) ) {
			GFAPI::update_entry_property( $entry['id'], 'status', 'trash' );
		}
	},
	999
);

// Contact Form 7: skip spam/CAPTCHA checks, don't store in Flamingo.
add_filter( 'wpcf7_skip_spam_check', '__return_true', 999 );
add_filter( 'wpcf7_spam', '__return_false', 999 );
add_filter( 'wpcf7_flamingo_submit_if', function () { return array(); }, 999 );

// WPForms: skip CAPTCHA, don't save the entry.
add_filter( 'wpforms_process_bypass_captcha', '__return_true', 999 );
add_filter( 'wpforms_entry_save', '__return_false', 999 );

// Simple Cloudflare Turnstile plugin (if installed): treat the test as allow-listed.
add_filter( 'cfturnstile_whitelisted', '__return_true', 999 );
